const root = document.documentElement;
const shell = document.getElementById('shell');
const darkBtn = document.getElementById('t-dark');
const lightBtn = document.getElementById('t-light');
const darkIcon = darkBtn.querySelector('svg');
const lightIcon = lightBtn.querySelector('svg');

const THEMES = {
  dark: {
    bg: '#18181b', panel: '#1f1f23', border: '#2f2f35',
    text: '#efeff1', muted: '#7c7c85', accent: '#a970ff', 'accent-text': '#0e0e10',
    'btn-border': '#3d3d44'
  },
  light: {
    bg: '#f7f7f8', panel: '#ffffff', border: '#e3e3e8',
    text: '#0e0e10', muted: '#6b6b76', accent: '#7a3ff2', 'accent-text': '#ffffff',
    'btn-border': '#d3d3da'
  }
};

function applyTheme(name) {
  const key = name === 'light' ? 'light' : 'dark';
  const t = THEMES[key];

  for (const k in t) root.style.setProperty('--' + k, t[k]);

  root.style.background = t.bg;
  root.style.colorScheme = key;
  document.body.style.background = t.bg;
  document.body.style.color = t.text;

  shell.style.background = t.bg;
  shell.style.color = t.text;

  const active = { background: t.accent, border: '1px solid ' + t.accent };
  const idle = { background: 'transparent', border: '1px solid ' + t.border };

  Object.assign(darkBtn.style, key === 'dark' ? active : idle);
  Object.assign(lightBtn.style, key === 'light' ? active : idle);

  const darkInk = key === 'dark' ? t['accent-text'] : t.text;
  const lightInk = key === 'light' ? t['accent-text'] : t.text;

  darkIcon.style.fill = darkInk;
  lightIcon.style.fill = lightInk;
  lightIcon.style.stroke = lightInk;

  root.setAttribute('data-theme', key);

  try { localStorage.setItem('vtcaTheme', key); } catch (e) {}
}

let saved = 'dark';
try { saved = localStorage.getItem('vtcaTheme') === 'light' ? 'light' : 'dark'; } catch (e) {}
applyTheme(saved);

darkBtn.addEventListener('click', () => applyTheme('dark'));
lightBtn.addEventListener('click', () => applyTheme('light'));

const box = document.getElementById('an');

try {
  chrome.storage.local.get({ analyzerEnabled: true }, (cfg) => {
    box.checked = !cfg || cfg.analyzerEnabled !== false;
  });
} catch (e) {}

box.addEventListener('change', () => {
  try { chrome.storage.local.set({ analyzerEnabled: box.checked }); } catch (e) {}
});

document.getElementById('clear').addEventListener('click', () => {
  const btn = document.getElementById('clear');
  try { chrome.storage.local.set({ vtcaClear: Date.now() }); } catch (e) {}
  btn.textContent = 'Cleared';
  setTimeout(() => { btn.textContent = 'Clear saved analysis'; }, 1200);
});