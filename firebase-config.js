// ============================================================
//  firebase-config.js - Firebase 설정값
//
//  설정 방법:
//    1. https://console.firebase.google.com 접속
//    2. "프로젝트 만들기" → 이름 입력 (예: my-diary)
//    3. 프로젝트 설정(톱니바퀴) → "앱 추가" → 웹(</>)
//    4. 앱 닉네임 입력 후 "앱 등록"
//    5. 아래 firebaseConfig 코드가 나오면 복사해서 붙여넣기
//
//  Firestore 데이터베이스 만들기:
//    1. 왼쪽 메뉴 "Firestore Database" → "데이터베이스 만들기"
//    2. "테스트 모드로 시작" 선택 (30일 후 보안 규칙 설정 필요)
//    3. 서버 위치: asia-northeast3 (서울) 선택
// ============================================================

const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyBo4ELITxj21ynSBpZ_Ij5MLII5bdPbpDA',   // ← Firebase 콘솔 → 프로젝트 설정 → 웹앱에서 복사
  authDomain:        'my-diary-8f545.firebaseapp.com',
  projectId:         'my-diary-8f545',
  storageBucket:     'my-diary-8f545.appspot.com',
  messagingSenderId: '1026141611987',
  appId:             '1:1026141611987:web:30adcfd03a4ce5f676f126',
};
