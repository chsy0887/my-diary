// ============================================================
//  setup.js - PWA 아이콘 생성 스크립트
//
//  실행 방법: node setup.js
//  결과: icons/icon-192.png, icons/icon-512.png 생성
//
//  npm 패키지 불필요 - Node.js 내장 모듈만 사용
// ============================================================

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ============================================================
//  CRC32 계산 (PNG 청크 무결성 검사에 필수)
// ============================================================
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c;
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ============================================================
//  PNG 청크 생성 (길이 + 타입 + 데이터 + CRC32)
// ============================================================
function makePNGChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf  = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// ============================================================
//  아이콘 이미지 데이터 생성
//  디자인: 보라색 그라디언트 배경 + 책 모양 (일기장 아이콘)
// ============================================================
function generateIconPixels(size) {
  // 책 레이아웃 계산 (size 기준 비율)
  const margin   = Math.round(size * 0.14);
  const bookL    = margin;
  const bookR    = size - margin;
  const bookT    = margin;
  const bookB    = size - margin;
  const spineW   = Math.round((bookR - bookL) * 0.16); // 책 등 너비
  const lineH    = Math.max(2, Math.round(size * 0.018)); // 줄 두께

  // 페이지 안 줄 위치 계산
  const pageL    = bookL + spineW + Math.round((bookR - bookL - spineW) * 0.08);
  const pageR    = bookR - Math.round((bookR - bookL) * 0.05);
  const lineAreaT = bookT + Math.round((bookB - bookT) * 0.22);
  const lineAreaB = bookB - Math.round((bookB - bookT) * 0.10);
  const lineStep  = Math.round((bookB - bookT) * 0.145);

  // 픽셀 데이터 버퍼 (각 행: 필터바이트 1 + RGB 3*width)
  const rawData = Buffer.alloc(size * (1 + size * 3));

  for (let y = 0; y < size; y++) {
    rawData[y * (1 + size * 3)] = 0; // PNG 필터 타입: None

    for (let x = 0; x < size; x++) {
      const offset = y * (1 + size * 3) + 1 + x * 3;
      let r, g, b;

      const inBook  = x >= bookL && x < bookR && y >= bookT && y < bookB;
      const inSpine = inBook && x < bookL + spineW;
      const inPage  = inBook && !inSpine;

      if (inSpine) {
        // 책 등: 진한 보라
        r = 80; g = 35; b = 115;

      } else if (inPage) {
        // 책 페이지: 연한 크림색
        r = 253; g = 249; b = 255;

        // 줄 그리기 (페이지 안 가로선)
        const relY = y - lineAreaT;
        if (y >= lineAreaT && y < lineAreaB && x >= pageL && x < pageR) {
          if (relY % lineStep < lineH) {
            r = 195; g = 172; b = 220; // 연보라 줄
          }
        }

      } else {
        // 배경: 좌상→우하 보라 그라디언트
        const t = (x + y) / (2 * (size - 1)); // 0.0 ~ 1.0
        r = Math.round(197 + (100 - 197) * t); // #C5→#64
        g = Math.round(169 + ( 48 - 169) * t); // #A9→#30
        b = Math.round(224 + (154 - 224) * t); // #E0→#9A
      }

      rawData[offset]     = r;
      rawData[offset + 1] = g;
      rawData[offset + 2] = b;
    }
  }

  return rawData;
}

// ============================================================
//  PNG 파일 생성 (시그니처 + IHDR + IDAT + IEND)
// ============================================================
function generatePNG(size) {
  const rawData = generateIconPixels(size);

  // IHDR: 이미지 헤더 청크
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // 가로
  ihdr.writeUInt32BE(size, 4); // 세로
  ihdr[8]  = 8; // 비트 깊이: 8
  ihdr[9]  = 2; // 색상 타입: RGB (알파 없음)
  ihdr[10] = 0; // 압축 방식: deflate
  ihdr[11] = 0; // 필터 방식
  ihdr[12] = 0; // 인터레이스: 없음

  // IDAT: 픽셀 데이터를 zlib로 압축
  const compressed = zlib.deflateSync(rawData, { level: 6 });

  return Buffer.concat([
    // PNG 파일 시그니처 (고정값)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    makePNGChunk('IHDR', ihdr),
    makePNGChunk('IDAT', compressed),
    makePNGChunk('IEND', Buffer.alloc(0)), // 파일 끝 마커
  ]);
}

// ============================================================
//  실행: icons/ 폴더 생성 후 두 가지 크기 아이콘 저장
// ============================================================
console.log('');
console.log('🎨 아이콘을 생성하고 있어요...');
console.log('');

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir);
  console.log('📁 icons/ 폴더를 만들었어요.');
}

// 192×192 (앱 서랍, 일반 홈 화면)
const png192 = generatePNG(192);
fs.writeFileSync(path.join(iconsDir, 'icon-192.png'), png192);
console.log('✅ icons/icon-192.png  생성 완료 (192×192)');

// 512×512 (스플래시 화면, 고해상도 디스플레이)
const png512 = generatePNG(512);
fs.writeFileSync(path.join(iconsDir, 'icon-512.png'), png512);
console.log('✅ icons/icon-512.png  생성 완료 (512×512)');

console.log('');
console.log('🎉 완료! 이제 아래 순서대로 해주세요:');
console.log('   1. node server.js  로 서버 시작');
console.log('   2. 브라우저에서 http://localhost:3000 열기');
console.log('   3. 주소창 오른쪽 설치 버튼(⊕) 또는 메뉴에서 "앱 설치" 클릭');
console.log('');
