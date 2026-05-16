// ============================================================
//  server.js - 나의 일기장 로컬 서버
//
//  역할:
//    1. index.html / style.css / script.js 파일을 브라우저에 제공
//    2. /api/analyze 엔드포인트로 Claude API를 대신 호출
//       → API 키가 브라우저에 절대 노출되지 않음
//
//  실행 방법: node server.js
//  접속 주소: http://localhost:3000
//
//  필요한 것: Node.js (https://nodejs.org) - npm 설치 불필요
// ============================================================

// Node.js 내장 모듈만 사용 (npm install 불필요)
const http  = require('http');   // HTTP 서버
const https = require('https');  // Claude API 호출 (HTTPS)
const fs    = require('fs');     // 파일 읽기
const path  = require('path');   // 경로 처리

// ============================================================
//  .env 파일 읽기: CLAUDE_API_KEY를 환경변수로 로드
// ============================================================
function loadEnv() {
  try {
    const envPath    = path.join(__dirname, '.env');
    const envContent = fs.readFileSync(envPath, 'utf8');

    // 줄 단위로 분리해서 KEY=VALUE 형식 파싱
    envContent.split('\n').forEach(function (line) {
      line = line.trim();
      if (!line || line.startsWith('#')) return; // 빈 줄, 주석 무시

      const eqIndex = line.indexOf('=');
      if (eqIndex === -1) return; // = 없는 줄 무시

      const key   = line.slice(0, eqIndex).trim();
      let   value = line.slice(eqIndex + 1).trim();

      // 값에 따옴표가 있으면 제거 (예: KEY="value" → value)
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    });

    console.log('.env 파일을 읽었어요.');
  } catch (e) {
    // .env 파일이 없어도 서버는 시작됨 (API 기능만 비활성화)
    console.warn('⚠️  .env 파일을 찾지 못했어요. .env 파일에 CLAUDE_API_KEY를 설정해주세요.');
  }
}

// 서버 시작 전에 .env 로드
loadEnv();

// 설정값
const PORT          = process.env.PORT || 3000;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

// ============================================================
//  파일 확장자별 MIME 타입 (브라우저에게 파일 종류 알려주기)
// ============================================================
const MIME_TYPES = {
  '.html':        'text/html; charset=utf-8',
  '.css':         'text/css; charset=utf-8',
  '.js':          'application/javascript; charset=utf-8',
  '.json':        'application/json; charset=utf-8',        // manifest.json
  '.ico':         'image/x-icon',
  '.png':         'image/png',
  '.svg':         'image/svg+xml',                           // SVG 아이콘
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

// ============================================================
//  JSON 응답 전송 헬퍼 함수
// ============================================================
function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ============================================================
//  callClaude - Claude API 호출 함수
//  일기 내용을 분석해서 JSON 결과를 callback으로 반환
// ============================================================
function callClaude(diaryText, mood, moodLabel, callback) {
  // Claude에게 보낼 프롬프트 (지시사항)
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

  // Claude API에 보낼 요청 본문
  const requestBody = JSON.stringify({
    model:      'claude-haiku-4-5-20251001', // 빠르고 가성비 좋은 모델
    max_tokens: 600,
    messages: [
      { role: 'user', content: prompt }
    ],
  });

  // Claude API 요청 옵션 (HTTPS)
  const requestOptions = {
    hostname: 'api.anthropic.com',
    path:     '/v1/messages',
    method:   'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length':    Buffer.byteLength(requestBody),
    },
  };

  // Claude API로 HTTPS 요청 전송
  const apiRequest = https.request(requestOptions, function (apiResponse) {
    let responseData = '';

    // 응답 데이터 수신
    apiResponse.on('data', function (chunk) {
      responseData += chunk;
    });

    // 응답 완료 - JSON 파싱 및 결과 추출
    apiResponse.on('end', function () {
      try {
        const parsed = JSON.parse(responseData);

        // API 오류 응답 확인
        if (parsed.error) {
          callback(new Error('Claude API 오류: ' + (parsed.error.message || '알 수 없는 오류')), null);
          return;
        }

        // Claude의 응답 텍스트 추출
        const aiText = parsed.content[0].text.trim();

        // Claude가 응답한 JSON 파싱
        // 가끔 ```json ... ``` 블록으로 감싸는 경우 처리
        const jsonMatch = aiText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          callback(new Error('AI가 올바른 형식으로 응답하지 않았어요.'), null);
          return;
        }

        const result = JSON.parse(jsonMatch[0]);
        callback(null, result);

      } catch (parseError) {
        callback(new Error('AI 응답 파싱 실패: ' + parseError.message), null);
      }
    });
  });

  // 네트워크 오류 처리
  apiRequest.on('error', function (networkError) {
    callback(new Error('인터넷 연결을 확인해주세요: ' + networkError.message), null);
  });

  // 요청 전송
  apiRequest.write(requestBody);
  apiRequest.end();
}

// ============================================================
//  HTTP 서버 생성 - 모든 요청을 여기서 처리
// ============================================================
const server = http.createServer(function (req, res) {

  // CORS 헤더: 같은 컴퓨터에서 개발 시 필요
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // OPTIONS 요청: 브라우저가 실제 요청 전에 보내는 확인 요청
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ===========================================================
  //  POST /api/analyze - AI 분석 엔드포인트
  //  브라우저가 일기 내용을 보내면 Claude API를 호출해서 결과 반환
  // ===========================================================
  if (req.method === 'POST' && req.url === '/api/analyze') {

    // API 키가 설정되지 않은 경우
    if (!CLAUDE_API_KEY || CLAUDE_API_KEY === '여기에_API_키를_입력하세요') {
      sendJSON(res, 500, {
        error: '.env 파일에 CLAUDE_API_KEY를 설정해주세요.\n' +
               'https://console.anthropic.com/settings/keys 에서 발급받을 수 있어요.',
      });
      return;
    }

    // 요청 본문(body) 수신
    let body = '';
    req.on('data', function (chunk) {
      body += chunk;
      // 너무 큰 요청은 거부 (10KB 초과)
      if (body.length > 10000) {
        req.destroy();
      }
    });

    req.on('end', function () {
      try {
        const { text, mood, moodLabel } = JSON.parse(body);

        // 일기 내용 검사
        if (!text || text.trim().length === 0) {
          sendJSON(res, 400, { error: '일기 내용이 비어있어요.' });
          return;
        }

        // Claude API 호출
        callClaude(
          text.trim(),
          mood      || '😐',
          moodLabel || '보통',
          function (err, result) {
            if (err) {
              sendJSON(res, 500, { error: err.message });
            } else {
              sendJSON(res, 200, result);
            }
          }
        );

      } catch (parseError) {
        sendJSON(res, 400, { error: '요청 형식이 잘못되었어요.' });
      }
    });

    return;
  }

  // ===========================================================
  //  GET 요청: 정적 파일 제공 (index.html, style.css, script.js)
  // ===========================================================
  let urlPath = req.url;

  // 루트 경로 → index.html
  if (urlPath === '/') urlPath = '/index.html';

  // 쿼리스트링 제거 (?foo=bar 부분 삭제)
  urlPath = urlPath.split('?')[0];

  // 경로 탐색 공격 방지 (../../ 등 상위 폴더 접근 차단)
  urlPath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');

  const fullPath = path.join(__dirname, urlPath);

  // 파일 읽기
  fs.readFile(fullPath, function (err, fileData) {
    if (err) {
      // 파일 없음
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('파일을 찾을 수 없어요: ' + urlPath);
      return;
    }

    // 파일 확장자로 Content-Type 결정
    const ext = path.extname(fullPath);
    const contentType = MIME_TYPES[ext] || 'text/plain; charset=utf-8';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(fileData);
  });
});

// ============================================================
//  서버 시작
// ============================================================
server.listen(PORT, function () {
  console.log('');
  console.log('🌸 나의 일기장 서버가 시작되었어요!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('   브라우저 주소창에 입력하세요:');
  console.log('   👉 http://localhost:' + PORT);
  console.log('');
  console.log('   종료하려면 Ctrl+C 를 누르세요.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // API 키 설정 상태 안내
  if (!CLAUDE_API_KEY || CLAUDE_API_KEY === '여기에_API_키를_입력하세요') {
    console.log('');
    console.log('⚠️  AI 기능을 사용하려면:');
    console.log('   .env 파일을 열고 CLAUDE_API_KEY=sk-ant-... 형식으로 입력하세요.');
    console.log('   키 발급: https://console.anthropic.com/settings/keys');
  } else {
    console.log('');
    console.log('✅  API 키 확인 완료! AI 기능을 사용할 수 있어요.');
  }
  console.log('');
});
