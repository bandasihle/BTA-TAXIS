// The download page: fills in the latest version from /download/version.json. Until a version
// has been published, the button stays off and says so.
const $ = (id) => document.getElementById(id);

function size(bytes) {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

async function load() {
  const go = $('dl-go');
  let v;
  try {
    const res = await fetch('/download/version.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(String(res.status));
    v = await res.json();
  } catch {
    go.textContent = 'Could not reach the server. Try again';
    go.removeAttribute('aria-disabled');
    go.href = '/download';
    return;
  }
  if (!v.apkUrl) {
    go.textContent = 'Coming soon';
    return;
  }
  go.textContent = `Download for Android`;
  go.removeAttribute('aria-disabled');
  $('dl-version').textContent = v.versionName;
  $('dl-date').textContent = v.releasedAt
    ? new Date(`${v.releasedAt}T12:00:00`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })
    : '';
  $('dl-size').textContent = v.sizeBytes ? size(v.sizeBytes) : '';
  $('dl-hash').textContent = v.sha256 || '';
  $('dl-facts').hidden = false;
}

load();
