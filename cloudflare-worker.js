const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
function jsonError(msg, status = 400) { return jsonResp({ error: msg }, status); }

function igHeaders(env) {
  const cookies = `sessionid=${env.INSTAGRAM_SESSION_ID}; csrftoken=${env.INSTAGRAM_CSRF_TOKEN}; ds_user_id=${env.INSTAGRAM_DS_USER_ID}`;
  return {
    'Cookie': cookies,
    'X-CSRFToken': env.INSTAGRAM_CSRF_TOKEN,
    'X-IG-App-ID': '936619743392459',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
    'Referer': 'https://www.instagram.com/',
    'Origin': 'https://www.instagram.com',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Instagram-AJAX': '1',
  };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    try {
      if (action === 'transcribe') {
        const videoUrl = url.searchParams.get('video_url');
        if (!videoUrl) return jsonError('video_url required');
        return transcribeVideo(videoUrl, env);
      }
      if (action === 'analyze') {
        const body = await request.json().catch(() => ({}));
        return analyzeReelContent(body.transcription || '', body.caption || '', env);
      }
      // ── Shared lists (KV) ──────────────────────────────────────────────
      if (action === 'share_create') {
        if (!env.REELS_KV) return jsonError('KV не настроен — добавь REELS_KV binding в Worker', 503);
        const body = await request.json().catch(() => ({}));
        const accounts = body.accounts || [];
        const id = Math.random().toString(36).slice(2, 9);
        await env.REELS_KV.put(`share:${id}`, JSON.stringify({ accounts, updated: Date.now() }), { expirationTtl: 60 * 24 * 3600 });
        return jsonResp({ id });
      }
      if (action === 'share_get') {
        if (!env.REELS_KV) return jsonError('KV не настроен', 503);
        const id = url.searchParams.get('id');
        if (!id) return jsonError('id required');
        const data = await env.REELS_KV.get(`share:${id}`, 'json');
        if (!data) return jsonError('Список не найден или истёк (60 дней)', 404);
        return jsonResp(data);
      }
      if (action === 'share_set') {
        if (!env.REELS_KV) return jsonError('KV не настроен', 503);
        const id = url.searchParams.get('id');
        if (!id) return jsonError('id required');
        const body = await request.json().catch(() => ({}));
        const accounts = body.accounts || [];
        await env.REELS_KV.put(`share:${id}`, JSON.stringify({ accounts, updated: Date.now() }), { expirationTtl: 60 * 24 * 3600 });
        return jsonResp({ ok: true, updated: Date.now() });
      }
      // ──────────────────────────────────────────────────────────────────
      const username = url.searchParams.get('username');
      if (!username) return jsonError('username required');
      return fetchUserReels(username, env);
    } catch (e) {
      return jsonError('Worker error: ' + e.message, 500);
    }
  }
};

// ── User reels ────────────────────────────────────────────────────────────
async function fetchUserReels(username, env) {
  const profileResp = await fetch(
    `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
    { headers: { ...igHeaders(env), 'Referer': `https://www.instagram.com/${username}/` }, redirect: 'manual' }
  );
  if (profileResp.status >= 300) return jsonError(`Instagram вернул ${profileResp.status}.`);
  const profileData = await profileResp.json();
  const user = profileData?.data?.user;
  if (!user) return jsonError('Аккаунт не найден');
  const reelsResp = await fetch('https://www.instagram.com/api/v1/clips/user/', {
    method: 'POST',
    headers: { ...igHeaders(env), 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': `https://www.instagram.com/${username}/reels/` },
    body: `target_user_id=${user.id}&page_size=50&include_feed_video=true`,
    redirect: 'manual'
  });
  if (reelsResp.status >= 300) return jsonError(`Ошибка загрузки рилсов: ${reelsResp.status}`);
  const reelsData = await reelsResp.json();
  const reels = (reelsData?.items || []).map(item => {
    const m = item.media || item;
    const vv = m.video_versions || [];
    return {
      shortcode: m.code,
      url: `https://www.instagram.com/reel/${m.code}/`,
      thumbnail: m.image_versions2?.candidates?.[0]?.url || '',
      video_url: vv[vv.length - 1]?.url || vv[0]?.url || '',
      views: m.view_count || m.play_count || 0,
      likes: m.like_count || 0,
      comments: m.comment_count || 0,
      caption: m.caption?.text || '',
      timestamp: (m.taken_at || 0) * 1000,
      username: user.username,
      avatar: user.profile_pic_url,
    };
  });
  return jsonResp({ user: { username: user.username, full_name: user.full_name, avatar: user.profile_pic_url }, reels });
}

// ── Parse clips response (same structure as clips/user) ───────────────────
function parseClipsItems(items, hashtag) {
  return (items || []).map(item => {
    const m = item.media || item;
    const vv = m.video_versions || [];
    return {
      shortcode: m.code,
      url: `https://www.instagram.com/reel/${m.code}/`,
      thumbnail: m.image_versions2?.candidates?.[0]?.url || '',
      video_url: vv[vv.length - 1]?.url || vv[0]?.url || '',
      views: m.view_count || m.play_count || 0,
      likes: m.like_count || 0,
      comments: m.comment_count || 0,
      caption: m.caption?.text || '',
      timestamp: (m.taken_at || 0) * 1000,
      username: m.user?.username || '',
      avatar: m.user?.profile_pic_url || '',
      hashtag,
    };
  }).filter(r => r.shortcode);
}

async function fetchHashtagReels(hashtag, env) {
  const h = igHeaders(env);
  const log = [];

  // Approach 1: clips/hashtag (same family as clips/user which works!)
  for (const body of [
    `hashtag=${encodeURIComponent(hashtag)}&page_size=20&include_feed_video=true`,
    `hashtag_name=${encodeURIComponent(hashtag)}&page_size=20`,
    `tag_name=${encodeURIComponent(hashtag)}&page_size=20`,
  ]) {
    try {
      const r = await fetch('https://www.instagram.com/api/v1/clips/hashtag/', {
        method: 'POST',
        headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': `https://www.instagram.com/explore/tags/${encodeURIComponent(hashtag)}/` },
        body, redirect: 'manual'
      });
      log.push({ approach: 'clips/hashtag', status: r.status, body });
      if (r.ok) {
        const d = await r.json();
        const reels = parseClipsItems(d.items, hashtag);
        if (reels.length) return jsonResp({ reels, hashtag, source: 'clips/hashtag' });
        log.push({ keys: Object.keys(d) });
      }
    } catch(e) { log.push({ approach: 'clips/hashtag', error: e.message }); }
  }

  // Approach 2: discover topical explore with hashtag module
  try {
    const r = await fetch(`https://www.instagram.com/api/v1/discover/topical_explore/?module=hashtag_followup&tag_name=${encodeURIComponent(hashtag)}&first=12`, {
      headers: h, redirect: 'manual'
    });
    log.push({ approach: 'topical_explore', status: r.status });
    if (r.ok) {
      const d = await r.json();
      // explore returns sectioned media
      const items = (d.sectional_items || []).flatMap(s =>
        (s.layout_content?.medias || []).map(m => m.media).filter(m => m?.video_versions?.length)
      );
      const reels = parseClipsItems(items, hashtag);
      if (reels.length) return jsonResp({ reels, hashtag, source: 'topical_explore' });
      log.push({ keys: Object.keys(d) });
    }
  } catch(e) { log.push({ approach: 'topical_explore', error: e.message }); }

  // Approach 3: reels/search or reels/topic
  try {
    const r = await fetch(`https://www.instagram.com/api/v1/clips/music/clips/?`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `hashtag=${encodeURIComponent(hashtag)}&page_size=20`,
      redirect: 'manual'
    });
    log.push({ approach: 'clips/music/clips', status: r.status });
  } catch(e) { log.push({ approach: 'clips/music/clips', error: e.message }); }

  return jsonResp({ reels: [], hashtag, log, error: 'All approaches returned 0 reels' });
}

// ── Debug: test all approaches, show raw previews ─────────────────────────
async function debugHashtag(hashtag, env) {
  const h = igHeaders(env);
  const enc = encodeURIComponent(hashtag);
  const results = {};

  // Test clips/hashtag (main hope)
  try {
    const r = await fetch('https://www.instagram.com/api/v1/clips/hashtag/', {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `hashtag=${enc}&page_size=20&include_feed_video=true`,
      redirect: 'manual'
    });
    results.clips_hashtag_status = r.status;
    if (r.ok) { const t = await r.text(); results.clips_hashtag_preview = t.slice(0, 600); }
    else { results.clips_hashtag_location = r.headers.get('location'); }
  } catch(e) { results.clips_hashtag_error = e.message; }

  // Test topical explore
  try {
    const r = await fetch(`https://www.instagram.com/api/v1/discover/topical_explore/?module=hashtag_followup&tag_name=${enc}&first=12`, {
      headers: h, redirect: 'manual'
    });
    results.topical_explore_status = r.status;
    if (r.ok) { const t = await r.text(); results.topical_explore_preview = t.slice(0, 400); }
    else { results.topical_explore_location = r.headers.get('location'); }
  } catch(e) { results.topical_explore_error = e.message; }

  // Test clips/trending
  try {
    const r = await fetch('https://www.instagram.com/api/v1/clips/trending/', {
      headers: h, redirect: 'manual'
    });
    results.clips_trending_status = r.status;
    if (r.ok) { const t = await r.text(); results.clips_trending_preview = t.slice(0, 400); }
  } catch(e) { results.clips_trending_error = e.message; }

  // Test clips/home
  try {
    const r = await fetch('https://www.instagram.com/api/v1/clips/home/', {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'page_size=10',
      redirect: 'manual'
    });
    results.clips_home_status = r.status;
    if (r.ok) { const t = await r.text(); results.clips_home_preview = t.slice(0, 400); }
  } catch(e) { results.clips_home_error = e.message; }

  return jsonResp(results);
}

// ── GPT Analysis ──────────────────────────────────────────────────────────
async function analyzeReelContent(transcription, caption, env) {
  if (!env.OPENAI_API_KEY) return jsonError('OPENAI_API_KEY не настроен');
  const content = [
    transcription ? `ТРАНСКРИПЦИЯ АУДИО:\n${transcription}` : '',
    caption       ? `ПОДПИСЬ К РОЛИКУ:\n${caption}`         : '',
  ].filter(Boolean).join('\n\n');
  if (!content) return jsonError('Нет данных для анализа');

  const prompt = `Ты эксперт по анализу контента для Instagram Reels. Анализируй ролик и возвращай ТОЛЬКО JSON без markdown.

ДАННЫЕ РОЛИКА:
${content}

Верни JSON строго в таком формате:
{
  "тема": "тема ролика в 3-5 словах",
  "боль": "боль аудитории в 3-6 словах",
  "формат": "один из: Ролик-совет, Ролик-стеб, Объяснение сложной темы, Ролик-ситуация + совет, Числовой формат, Ролик-сценка, Стеб + объяснение + выход, Проблема ЦА → решение, Другой формат",
  "виральность": ["критерий1", "критерий2"],
  "хук": "первая цепляющая фраза или зацепка",
  "интерес": "за счёт чего держит интерес в 5-8 словах",
  "cta": "призыв к действию или Отсутствует",
  "вирал_потенциал": "Низкий или Средний или Высокий или Очень высокий",
  "резюме": "о чём ролик в одном предложении",
  "сила": "главная сила ролика",
  "слабость": "главная слабость или упущенная возможность"
}

Критерии виральности (только из этого списка, может быть несколько):
Когнитивные искажения, Раздражающие шаблоны, Фрустрации от конкуренции, Нереалистичные ожидания, Табу-правда профессии, Социо-культурные метафоры, Скрытые потребности, Эффект «да, у меня тоже так», Сериальность, Сюжеты трансформации, Стиль восприятия, Социальный сигнал, Поведенческие сигналы

Если данных недостаточно — пиши "Не хватает данных".`;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: 800,
    })
  });
  if (!resp.ok) return jsonError(`GPT ошибка: ${await resp.text()}`, 500);
  const result = await resp.json();
  try {
    const analysis = JSON.parse(result.choices[0].message.content);
    return jsonResp({ analysis });
  } catch(e) { return jsonError('Не удалось разобрать ответ GPT', 500); }
}

async function transcribeVideo(videoUrl, env) {
  if (!env.OPENAI_API_KEY) return jsonError('OPENAI_API_KEY не настроен');
  const videoResp = await fetch(videoUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.instagram.com/' } });
  if (!videoResp.ok) return jsonError(`Не удалось загрузить видео: ${videoResp.status}`);
  const formData = new FormData();
  formData.append('file', await videoResp.blob(), 'audio.mp4');
  formData.append('model', 'whisper-1');
  formData.append('language', 'ru');
  const whisperResp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}` }, body: formData
  });
  if (!whisperResp.ok) return jsonError(`Whisper error: ${await whisperResp.text()}`, 500);
  const result = await whisperResp.json();
  return jsonResp({ transcription: result.text });
}
