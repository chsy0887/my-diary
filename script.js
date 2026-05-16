// ============================================================
//  script.js - 나의 일기장 (Firebase Auth + Firestore 연동)
//
//  - firebase-config.js에 설정값이 있으면 Google 로그인 + Firestore 사용
//  - 설정 없으면 localStorage 사용 (오프라인 전용, 로그인 불필요)
// ============================================================

// ============================================================
//  Firebase 초기화 & 인증
// ============================================================
let db          = null; // Firestore 인스턴스 (null = localStorage 모드)
let currentUser = null; // 현재 로그인한 사용자

function updateSyncBadge(mode) {
  const badge = document.getElementById('sync-badge');
  const text  = document.getElementById('sync-text');
  if (!badge || !text) return;
  badge.className = 'sync-badge sync-badge--' + mode;
  text.textContent = mode === 'cloud' ? '☁️ 클라우드 동기화 중' : '📱 이 기기에만 저장됨';
}

function updateUserUI(user) {
  const avatar   = document.getElementById('user-avatar');
  const nameEl   = document.getElementById('user-name');
  const userInfo = document.getElementById('user-info');
  if (!userInfo) return;
  if (avatar) {
    avatar.src = user.photoURL || '';
    avatar.style.display = user.photoURL ? 'block' : 'none';
  }
  if (nameEl) nameEl.textContent = user.displayName || user.email || '';
  userInfo.classList.remove('hidden');
}

function initFirebase() {
  try {
    if (typeof FIREBASE_CONFIG === 'undefined' ||
        !FIREBASE_CONFIG.projectId ||
        FIREBASE_CONFIG.projectId === '여기에-붙여넣기') {
      console.log('[Firebase] 설정이 없어요. localStorage를 사용합니다.');
      updateSyncBadge('local');
      return;
    }

    firebase.initializeApp(FIREBASE_CONFIG);
    db = firebase.firestore();

    db.enablePersistence({ synchronizeTabs: true }).catch(function (err) {
      if (err.code !== 'failed-precondition') {
        console.warn('[Firebase] 오프라인 캐시 비활성화:', err.code);
      }
    });

    // 로그인 상태 변화 감지
    firebase.auth().onAuthStateChanged(async function (user) {
      if (user) {
        currentUser = user;
        updateSyncBadge('cloud');
        updateUserUI(user);
        document.getElementById('login-screen').classList.add('hidden');
        document.getElementById('app-container').classList.remove('hidden');
        await migrateLocalStorageToFirestore();
        await loadDiaries();
      } else {
        currentUser = null;
        const userInfo = document.getElementById('user-info');
        if (userInfo) userInfo.classList.add('hidden');
        document.getElementById('login-screen').classList.remove('hidden');
        document.getElementById('app-container').classList.add('hidden');
      }
    });

  } catch (err) {
    console.error('[Firebase] 초기화 실패:', err.message);
    db = null;
    updateSyncBadge('local');
  }
}

async function signInWithGoogle() {
  const btn = document.getElementById('google-login-btn');
  const originalHTML = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = '로그인 중...';
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    await firebase.auth().signInWithPopup(provider);
    // onAuthStateChanged 콜백이 화면 전환을 처리합니다
  } catch (err) {
    console.error('[Auth] 로그인 실패:', err.message);
    if (err.code !== 'auth/popup-closed-by-user') {
      alert('로그인에 실패했어요. 다시 시도해 주세요.');
    }
    btn.disabled  = false;
    btn.innerHTML = originalHTML;
  }
}

async function signOutUser() {
  if (!confirm('로그아웃 하시겠어요?')) return;
  await firebase.auth().signOut();
  // onAuthStateChanged 콜백이 로그인 화면으로 전환합니다
}

// ============================================================
//  상태 변수
// ============================================================
const STORAGE_KEY = 'my-diary-entries';

let selectedMood      = null;
let selectedMoodLabel = null;
let currentAIResult   = null;

const MOOD_SCORE = { '😢': 1, '😕': 2, '😐': 3, '🙂': 4, '😊': 5 };

let calendarYear      = new Date().getFullYear();
let calendarMonth     = new Date().getMonth();
let moodChartInstance = null;

// ============================================================
//  데이터 접근 레이어 (Firestore ↔ localStorage 자동 전환)
// ============================================================

// 현재 사용자의 Firestore diaries 컬렉션 참조 반환
function getDiariesRef() {
  if (db && currentUser) {
    return db.collection('users').doc(currentUser.uid).collection('diaries');
  }
  return null;
}

async function loadDiariesFromDB() {
  const ref = getDiariesRef();
  if (ref) {
    try {
      const snapshot = await ref.orderBy('createdAt', 'desc').get();
      return snapshot.docs.map(function (doc) {
        return Object.assign({}, doc.data(), { id: doc.id });
      });
    } catch (err) {
      console.error('[Firebase] 불러오기 실패, localStorage 폴백:', err.message);
    }
  }
  return loadFromStorage();
}

async function saveDiaryToDB(diary) {
  const ref = getDiariesRef();
  if (ref) {
    try {
      const { id, ...data } = diary;
      const docRef = await ref.add(data);
      return docRef.id;
    } catch (err) {
      console.error('[Firebase] 저장 실패, localStorage 폴백:', err.message);
    }
  }
  const entries = loadFromStorage();
  entries.unshift(diary);
  saveToStorage(entries);
  return diary.id;
}

async function deleteDiaryFromDB(id) {
  const ref = getDiariesRef();
  if (ref) {
    try {
      await ref.doc(id).delete();
      return;
    } catch (err) {
      console.error('[Firebase] 삭제 실패, localStorage 폴백:', err.message);
    }
  }
  const entries = loadFromStorage();
  saveToStorage(entries.filter(function (e) { return e.id !== id; }));
}

// 사용자별 최초 로그인 시 localStorage 데이터를 Firestore로 이전
async function migrateLocalStorageToFirestore() {
  const ref = getDiariesRef();
  if (!ref) return;

  const migKey = 'firestore_migrated_' + currentUser.uid;
  if (localStorage.getItem(migKey)) return;

  const localEntries = loadFromStorage();
  if (localEntries.length === 0) {
    localStorage.setItem(migKey, 'true');
    return;
  }

  console.log('[마이그레이션] 기존 일기 ' + localEntries.length + '개를 Firestore로 이전 중...');
  for (const entry of localEntries.slice().reverse()) {
    const { id, ...data } = entry;
    await ref.add(data);
  }
  localStorage.setItem(migKey, 'true');
  console.log('[마이그레이션] ✅ 완료! 기존 일기가 Firestore로 이전되었어요.');
}

function loadFromStorage() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch (e) {
    return [];
  }
}

function saveToStorage(entries) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

// ============================================================
//  displayTodayDate - 오늘 날짜 표시
// ============================================================
function displayTodayDate() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('ko-KR', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });
  document.getElementById('today-date').textContent = dateStr;
}

// ============================================================
//  setupMoodSelection - 기분 버튼 클릭 이벤트
// ============================================================
function setupMoodSelection() {
  const moodButtons = document.querySelectorAll('.mood-btn');
  moodButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      moodButtons.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      selectedMood      = btn.dataset.mood;
      selectedMoodLabel = btn.dataset.label;
    });
  });
}

// ============================================================
//  setupCharCount - 글자 수 카운트
// ============================================================
function setupCharCount() {
  const textarea  = document.getElementById('diary-input');
  const charCount = document.getElementById('char-count');
  textarea.addEventListener('input', function () {
    charCount.textContent = textarea.value.length;
  });
}

// ============================================================
//  analyzeWithAI - AI 분석 요청
// ============================================================
async function analyzeWithAI() {
  const textarea = document.getElementById('diary-input');
  const text = textarea.value.trim();

  if (text.length === 0) { alert('일기를 먼저 작성해 주세요! ✏️'); return; }
  if (!selectedMood)      { alert('기분을 먼저 선택해 주세요! 😊'); return; }

  const resultBox = document.getElementById('ai-result-box');
  const loading   = document.getElementById('ai-loading');
  const content   = document.getElementById('ai-result-content');
  const aiBtn     = document.getElementById('ai-btn');

  resultBox.classList.remove('hidden');
  loading.classList.remove('hidden');
  content.classList.add('hidden');
  aiBtn.disabled = true;

  try {
    const response = await fetch('/api/analyze', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text, mood: selectedMood, moodLabel: selectedMoodLabel }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'AI 분석 오류');

    currentAIResult = data;
    renderAIResult(data);
    loading.classList.add('hidden');
    content.classList.remove('hidden');
  } catch (err) {
    loading.classList.add('hidden');
    resultBox.classList.add('hidden');
    const isNetwork = err.message.includes('fetch') || err.message.includes('Failed');
    alert(isNetwork
      ? 'AI 분석 서버에 연결하지 못했어요.\nnode server.js 를 실행해주세요.'
      : 'AI 분석 실패: ' + err.message);
  } finally {
    aiBtn.disabled = false;
  }
}

// ============================================================
//  renderAIResult - AI 결과를 화면에 표시
// ============================================================
function renderAIResult(data) {
  document.getElementById('ai-emotions').innerHTML = data.emotions.map(function (e) {
    return `
      <div class="emotion-row">
        <span class="emotion-name">${escapeHtml(e.name)}</span>
        <div class="emotion-bar-wrap">
          <div class="emotion-bar" style="width:${e.percentage}%"></div>
        </div>
        <span class="emotion-pct">${e.percentage}%</span>
      </div>`;
  }).join('');
  document.getElementById('ai-message').textContent = data.message;
  document.getElementById('ai-summary').textContent = '📝 ' + data.summary;
}

// ============================================================
//  saveDiary - 일기 저장
// ============================================================
async function saveDiary() {
  const textarea = document.getElementById('diary-input');
  const text = textarea.value.trim();

  if (!selectedMood)     { alert('오늘의 기분을 선택해 주세요! 😊'); return; }
  if (text.length === 0) { alert('일기 내용을 입력해 주세요! ✏️');   return; }

  const now     = new Date();
  const dateStr = now.toLocaleDateString('ko-KR', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });

  const newDiary = {
    id:        Date.now().toString(),
    date:      dateStr,
    mood:      selectedMood,
    moodLabel: selectedMoodLabel,
    text:      text,
    createdAt: now.toISOString(),
    aiResult:  currentAIResult,
  };

  const savedId = await saveDiaryToDB(newDiary);
  newDiary.id = savedId;

  textarea.value = '';
  document.getElementById('char-count').textContent = '0';
  document.querySelectorAll('.mood-btn').forEach(function (b) { b.classList.remove('active'); });
  selectedMood = null; selectedMoodLabel = null; currentAIResult = null;
  document.getElementById('ai-result-box').classList.add('hidden');
  document.getElementById('ai-result-content').classList.add('hidden');
  document.getElementById('ai-loading').classList.add('hidden');

  alert(newDiary.aiResult ? '일기와 AI 분석 결과가 저장되었어요! 🌟' : '일기가 저장되었어요! 🌟');
  await loadDiaries();
}

// ============================================================
//  loadDiaries - 일기 목록 화면 표시
// ============================================================
async function loadDiaries() {
  const diaryList    = document.getElementById('diary-list');
  const emptyMessage = document.getElementById('empty-message');
  const entries = await loadDiariesFromDB();

  if (entries.length === 0) {
    diaryList.innerHTML = '';
    emptyMessage.classList.remove('hidden');
    return;
  }
  emptyMessage.classList.add('hidden');
  diaryList.innerHTML = entries.map(renderDiaryCard).join('');
}

// ============================================================
//  renderDiaryCard - 일기 카드 HTML 생성
// ============================================================
function renderDiaryCard(diary) {
  const preview = diary.text.length > 150
    ? diary.text.slice(0, 150) + '...'
    : diary.text;

  const aiSection = diary.aiResult ? `
    <div class="card-ai">
      <p class="card-ai-label">✨ AI 분석</p>
      <p class="card-ai-summary">${escapeHtml(diary.aiResult.summary)}</p>
      <p class="card-ai-message">${escapeHtml(diary.aiResult.message)}</p>
    </div>` : '';

  return `
    <div class="diary-card" data-id="${diary.id}">
      <div class="card-header">
        <span class="card-mood">${diary.mood}</span>
        <span class="card-date">${escapeHtml(diary.date)}</span>
        <span class="card-mood-label">${escapeHtml(diary.moodLabel)}</span>
      </div>
      <p class="card-preview">${escapeHtml(preview)}</p>
      ${aiSection}
      <button class="delete-btn" onclick="deleteDiary('${diary.id}')">삭제</button>
    </div>`;
}

// ============================================================
//  deleteDiary - 일기 삭제
// ============================================================
async function deleteDiary(id) {
  if (!confirm('이 일기를 삭제할까요? 삭제하면 되돌릴 수 없어요.')) return;
  await deleteDiaryFromDB(id);
  await loadDiaries();
}

// ============================================================
//  escapeHtml - XSS 방지
// ============================================================
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;')
    .replace(/\n/g, '<br>');
}

// ============================================================
//  switchTab - 탭 전환
// ============================================================
async function switchTab(tabName) {
  document.querySelectorAll('.tab-content').forEach(function (el) { el.classList.add('hidden'); });
  document.querySelectorAll('.tab-btn').forEach(function (btn) { btn.classList.remove('active'); });
  document.getElementById('tab-' + tabName).classList.remove('hidden');
  document.querySelector('[data-tab="' + tabName + '"]').classList.add('active');
  if (tabName === 'calendar') await renderCalendar();
  if (tabName === 'stats')    await renderStats();
}

// ============================================================
//  renderCalendar - 달력 그리기
// ============================================================
async function renderCalendar() {
  const entries  = await loadDiariesFromDB();
  const diaryMap = {};
  entries.forEach(function (diary) {
    const key = diary.createdAt.slice(0, 10);
    if (!diaryMap[key]) diaryMap[key] = [];
    diaryMap[key].push(diary);
  });

  const monthNames = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];
  document.getElementById('cal-title').textContent =
    calendarYear + '년 ' + monthNames[calendarMonth];

  const grid = document.getElementById('cal-grid');
  while (grid.children.length > 7) grid.removeChild(grid.lastChild);

  const firstDayOfWeek = new Date(calendarYear, calendarMonth, 1).getDay();
  const daysInMonth    = new Date(calendarYear, calendarMonth + 1, 0).getDate();
  const todayKey       = new Date().toISOString().slice(0, 10);

  for (let i = 0; i < firstDayOfWeek; i++) {
    const empty = document.createElement('div');
    empty.className = 'cal-day';
    grid.appendChild(empty);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateKey = calendarYear + '-' +
      String(calendarMonth + 1).padStart(2, '0') + '-' +
      String(day).padStart(2, '0');
    const dayOfWeek = (firstDayOfWeek + day - 1) % 7;

    const cell = document.createElement('div');
    cell.className = 'cal-day';
    if (dayOfWeek === 0) cell.classList.add('sunday');
    if (dayOfWeek === 6) cell.classList.add('saturday');
    if (dateKey === todayKey) cell.classList.add('today');

    const numEl = document.createElement('span');
    numEl.className   = 'cal-num';
    numEl.textContent = day;
    cell.appendChild(numEl);

    if (diaryMap[dateKey] && diaryMap[dateKey].length > 0) {
      cell.classList.add('has-diary');
      const moodEl = document.createElement('span');
      moodEl.className   = 'cal-mood';
      moodEl.textContent = diaryMap[dateKey][diaryMap[dateKey].length - 1].mood;
      cell.appendChild(moodEl);
      const diariesOnDate = diaryMap[dateKey];
      cell.addEventListener('click', function () { openDiaryModal(diariesOnDate); });
    }
    grid.appendChild(cell);
  }
}

// ============================================================
//  navigateMonth - 달력 이전/다음 달
// ============================================================
function navigateMonth(direction) {
  calendarMonth += direction;
  if (calendarMonth > 11) { calendarMonth = 0;  calendarYear++; }
  if (calendarMonth <  0) { calendarMonth = 11; calendarYear--; }
  renderCalendar();
}

// ============================================================
//  openDiaryModal / closeDiaryModal
// ============================================================
function openDiaryModal(diaries) {
  document.getElementById('modal-content').innerHTML = diaries.map(function (diary, idx) {
    const aiSection = diary.aiResult ? `
      <div class="modal-ai">
        <p class="modal-ai-title">✨ AI 분석</p>
        <p class="modal-ai-summary">📝 ${escapeHtml(diary.aiResult.summary)}</p>
        <p class="modal-ai-message">${escapeHtml(diary.aiResult.message)}</p>
      </div>` : '';
    return (idx > 0 ? '<hr class="modal-divider">' : '') + `
      <p class="modal-date">${escapeHtml(diary.date)}</p>
      <div class="modal-mood-row">
        <span class="modal-mood-emoji">${diary.mood}</span>
        <span class="modal-mood-label">${escapeHtml(diary.moodLabel)}</span>
      </div>
      <p class="modal-text">${escapeHtml(diary.text)}</p>
      ${aiSection}`;
  }).join('');

  document.getElementById('diary-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeDiaryModal() {
  document.getElementById('diary-modal').classList.add('hidden');
  document.body.style.overflow = '';
}

// ============================================================
//  renderStats - 통계 탭
// ============================================================
async function renderStats() {
  const entries = await loadDiariesFromDB();

  document.getElementById('stat-total').textContent    = entries.length;
  document.getElementById('stat-streak').textContent   = calculateStreak(entries);
  document.getElementById('stat-ai-count').textContent =
    entries.filter(function (e) { return !!e.aiResult; }).length;

  const activePeriodBtn = document.querySelector('.period-btn.active');
  const days = parseInt(activePeriodBtn ? activePeriodBtn.dataset.days : '7');
  renderMoodChart(entries, days);
  renderTopEmotions(entries);
}

// ============================================================
//  calculateStreak - 연속 작성일
// ============================================================
function calculateStreak(entries) {
  if (!entries.length) return 0;
  const written = new Set(entries.map(function (e) { return e.createdAt.slice(0, 10); }));
  let streak = 0;
  const d = new Date();
  for (let i = 0; i < 365; i++) {
    if (written.has(d.toISOString().slice(0, 10))) {
      streak++;
      d.setDate(d.getDate() - 1);
    } else break;
  }
  return streak;
}

// ============================================================
//  renderMoodChart - 기분 변화 꺾은선 그래프
// ============================================================
function renderMoodChart(entries, days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days + 1);
  cutoff.setHours(0, 0, 0, 0);

  const filtered = entries
    .filter(function (e) { return new Date(e.createdAt) >= cutoff; })
    .sort(function (a, b) { return new Date(a.createdAt) - new Date(b.createdAt); });

  const canvas   = document.getElementById('mood-chart');
  const emptyMsg = document.getElementById('chart-empty');

  if (filtered.length < 2) {
    emptyMsg.classList.remove('hidden');
    canvas.style.display = 'none';
    if (moodChartInstance) { moodChartInstance.destroy(); moodChartInstance = null; }
    return;
  }

  emptyMsg.classList.add('hidden');
  canvas.style.display = 'block';

  const labels = filtered.map(function (e) {
    const d = new Date(e.createdAt);
    return (d.getMonth() + 1) + '/' + d.getDate();
  });
  const data = filtered.map(function (e) { return MOOD_SCORE[e.mood] || 3; });

  if (moodChartInstance) moodChartInstance.destroy();
  moodChartInstance = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
        borderColor:          '#b39ddb',
        backgroundColor:      'rgba(179,157,219,0.12)',
        fill:                 true,
        tension:              0.4,
        pointBackgroundColor: '#f48fb1',
        pointBorderColor:     'white',
        pointBorderWidth:     2,
        pointRadius:          6,
        pointHoverRadius:     8,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: true,
      scales: {
        y: {
          min: 0.5, max: 5.5,
          ticks: {
            stepSize: 1,
            callback: function (v) { return ['', '😢', '😕', '😐', '🙂', '😊'][v] || ''; },
            font: { size: 15 },
          },
          grid: { color: 'rgba(0,0,0,0.05)' },
        },
        x: { grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { font: { size: 12 } } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function (c) {
              return ['', '😢 슬픔', '😕 우울', '😐 보통', '🙂 좋음', '😊 행복'][c.parsed.y] || '';
            },
          },
        },
      },
    },
  });
}

// ============================================================
//  renderTopEmotions - 감정 TOP 3
// ============================================================
function renderTopEmotions(entries) {
  const container = document.getElementById('top-emotions');
  const totals    = {};
  let count = 0;

  entries.forEach(function (diary) {
    if (!diary.aiResult || !diary.aiResult.emotions) return;
    count++;
    diary.aiResult.emotions.forEach(function (e) {
      totals[e.name] = (totals[e.name] || 0) + e.percentage;
    });
  });

  if (count === 0) {
    container.innerHTML =
      '<p class="no-emotions-msg">AI 분석 결과가 없어요.<br>✨ AI 분석하기를 눌러 분석해보세요!</p>';
    return;
  }

  const top3   = Object.entries(totals).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 3);
  const maxVal = top3[0][1];
  const medals = ['🥇', '🥈', '🥉'];

  container.innerHTML = top3.map(function (entry, idx) {
    const [name, total] = entry;
    return `
      <div class="top-emotion-row">
        <span class="top-emotion-rank">${medals[idx]}</span>
        <span class="top-emotion-name">${escapeHtml(name)}</span>
        <div class="top-emotion-bar-wrap">
          <div class="top-emotion-bar" style="width:${Math.round(total / maxVal * 100)}%"></div>
        </div>
        <span class="top-emotion-pct">${Math.round(total / count)}%</span>
      </div>`;
  }).join('');
}

// ============================================================
//  초기화: 페이지 로드 후 실행
// ============================================================
document.addEventListener('DOMContentLoaded', async function () {
  displayTodayDate();
  setupMoodSelection();
  setupCharCount();

  // 이벤트 리스너 등록 (한 번만)
  document.getElementById('ai-btn').addEventListener('click', analyzeWithAI);
  document.getElementById('save-btn').addEventListener('click', saveDiary);
  document.getElementById('google-login-btn').addEventListener('click', signInWithGoogle);
  document.getElementById('logout-btn').addEventListener('click', signOutUser);

  document.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.addEventListener('click', async function () { await switchTab(btn.dataset.tab); });
  });

  document.getElementById('cal-prev').addEventListener('click', function () { navigateMonth(-1); });
  document.getElementById('cal-next').addEventListener('click', function () { navigateMonth(1); });

  document.getElementById('modal-close-btn').addEventListener('click', closeDiaryModal);
  document.getElementById('diary-modal').addEventListener('click', function (e) {
    if (e.target === this) closeDiaryModal();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDiaryModal(); });

  document.querySelectorAll('.period-btn').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      document.querySelectorAll('.period-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      const entries = await loadDiariesFromDB();
      renderMoodChart(entries, parseInt(btn.dataset.days));
    });
  });

  // Firebase 초기화 (Auth 리스너 포함)
  initFirebase();

  // localStorage 모드: 바로 앱 표시 (Firebase 설정이 없을 때)
  if (!db) {
    document.getElementById('app-container').classList.remove('hidden');
    await loadDiaries();
  }
  // Firebase 모드: onAuthStateChanged 콜백이 화면 전환 + 데이터 로드를 담당
});
