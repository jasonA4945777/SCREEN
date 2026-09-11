/**
 * 就醫資料截圖辨識 — Worker（網頁 + API 合併版）
 *
 * POST /api   接收圖片，轉給 OpenAI 辨識後回傳結果
 * 其他請求     回傳 public/ 裡的靜態網頁
 *
 * 需要在 Cloudflare 的 Settings → Variables and Secrets 設定：
 *   OPENAI_API_KEY  Secret   OpenAI 金鑰 sk-...
 *   APP_PASSCODE    Secret   自訂通行碼
 *   MODEL           Text     選填，預設 gpt-4o
 */

const PROMPT = `你是一個醫療行政資料擷取工具。請從這張截圖中找出所有病人的「姓名」、「病歷號」與「就醫日期」。

規則：
- 病歷號可能標示為病歷號、病歷號碼、病歷、chart no、MRN、ID 等，只取數字或英數編號。
- 就醫日期一律轉成 YYYY-MM-DD。若是民國年（例如 114/03/05 或 1140305），請加 1911 換算成西元。
- 一張圖若有多筆資料，就回傳多筆。
- 讀不到的欄位填空字串 ""，不要臆測或編造。

只輸出 JSON 陣列，不要任何說明文字或 markdown 標記，格式為：
[{"name":"","mrn":"","date":""}]`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 非 API 路徑一律交給靜態資源處理
    if (url.pathname !== '/api') {
      return env.ASSETS.fetch(request);
    }

    if (request.method !== 'POST') {
      return json({ error: '此路徑只接受 POST' }, 405);
    }

    if (request.headers.get('x-app-key') !== env.APP_PASSCODE) {
      return json({ error: '通行碼不正確' }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: '請求格式錯誤' }, 400);
    }

    const image = body.image;
    if (typeof image !== 'string' || !image.startsWith('data:image/')) {
      return json({ error: '沒有收到圖片' }, 400);
    }
    if (image.length > 7_000_000) {
      return json({ error: '圖片太大，請縮小後再試' }, 413);
    }

    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + env.OPENAI_API_KEY,
      },
      body: JSON.stringify({
        model: env.MODEL || 'gpt-4o',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: image, detail: 'high' } },
          ],
        }],
      }),
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      return json({ error: data.error?.message || ('上游回應 ' + upstream.status) }, upstream.status);
    }

    const text = (data.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
    const s = text.indexOf('['), e = text.lastIndexOf(']');
    if (s < 0) return json({ error: '模型沒有回傳可解析的資料' }, 502);

    try {
      return json({ records: JSON.parse(text.slice(s, e + 1)) }, 200);
    } catch {
      return json({ error: '結果解析失敗' }, 502);
    }
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
