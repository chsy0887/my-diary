// ============================================================
//  functions/index.js - Firebase Cloud Function (v2)
//
//  역할: /api/analyze 요청을 받아 Claude API를 호출하고 결과 반환
//  배포: Firebase Hosting의 /api/** 요청이 이 함수로 자동 라우팅됨
// ============================================================

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const https = require('https');

const CLAUDE_API_KEY = defineSecret('CLAUDE_API_KEY');

// ============================================================
//  callClaude - Claude API 호출 (Promise 기반)
// ============================================================
function callClaude(diaryText, mood, moodLabel, apiKey) {
  return new Promise(function (resolve, reject) {

    const prompt = `당신은 따뜻하고 공감 능력이 뛰어난 일기 분석 AI입니다.
아래 일기를 읽고 분석 결과를 JSON 형식으로만 응답해주세요.
JSON 외의 다른 텍스트(설명, 인사말 등)는 절대 포함하지 마세요.

일기 정보:
- 작성자 기분: ${mood} (${moodLabel})
- 일기 내용: ${diaryText}

응답 형식 (이 JSON만 출력, 다른 텍스트 금지):
{
  "emotions": [
    {"name": "감정이름", "percentage": 숫자}
  ],
  "message": "따뜻한 위로 또는 격려 메시지 (1~2문장, 한국어)",
  "summary": "일기 한 줄 요약 (15자 이내, 한국어)"
}

규칙:
- emotions 항목은 2~4개
- 모든 percentage 값의 합은 반드시 100
- message는 진심 어린 따뜻한 톤으로
- summary는 간결하게 핵심만`;

    const requestBody = JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages:   [{ role: 'user', content: prompt }],
    });

    const options = {
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length':    Buffer.byteLength(requestBody),
      },
    };

    const apiReq = https.request(options, function (apiRes) {
      let body = '';
      apiRes.on('data', function (chunk) { body += chunk; });
      apiRes.on('end', function () {
        try {
          const parsed = JSON.parse(body);
          if (parsed.error) {
            reject(new Error('Claude API 오류: ' + (parsed.error.message || '알 수 없는 오류')));
            return;
          }
          const aiText    = parsed.content[0].text.trim();
          const jsonMatch = aiText.match(/\{[\s\S]*\}/);
          if (!jsonMatch) {
            reject(new Error('AI가 올바른 형식으로 응답하지 않았어요.'));
            return;
          }
          resolve(JSON.parse(jsonMatch[0]));
        } catch (e) {
          reject(new Error('AI 응답 파싱 실패: ' + e.message));
        }
      });
    });

    apiReq.on('error', function (e) {
      reject(new Error('네트워크 오류: ' + e.message));
    });

    apiReq.write(requestBody);
    apiReq.end();
  });
}

// ============================================================
//  Cloud Function: api (v2)
//  Firebase Hosting의 /api/** 요청이 여기로 라우팅됩니다.
// ============================================================
exports.api = onRequest(
  {
    region:  'asia-northeast3',
    secrets: [CLAUDE_API_KEY],
  },
  async function (req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

    // Hosting 리라이트를 통해 오면 /api/analyze, 직접 호출이면 /analyze
    const isAnalyzePath = req.path === '/api/analyze' || req.path === '/analyze';
    if (req.method !== 'POST' || !isAnalyzePath) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const apiKey = CLAUDE_API_KEY.value().trim();
    if (!apiKey) {
      res.status(500).json({ error: 'API 키가 설정되지 않았어요.' });
      return;
    }

    const { text, mood, moodLabel } = req.body || {};
    if (!text || !text.trim()) {
      res.status(400).json({ error: '일기 내용이 비어있어요.' });
      return;
    }

    try {
      const result = await callClaude(
        text.trim(),
        mood      || '😐',
        moodLabel || '보통',
        apiKey
      );
      res.status(200).json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);
