// scenes for scripts/dialog-toasts-mockup.mjs: static html over a real olive window.
// keys: html (mockup layer), veil (tint the frozen tab pane), badge ([[tab title, text]] marks sidebar rows; '' = dot).
// review (#537) applied: no "page paused" chip by default, one header style for dialogs and permission
// cards (favicon + bare host), 16px padding, "2 tabs waiting" summary without a shortcut.
const head = (chip = '', who = 'gateway.acme.io says') => `<div class="head"><span class="fav">G</span><span class="origin">${who}</span>${chip ? `<span class="chip">${chip}</span>` : ''}</div>`;
const card = (inner) => `<div class="stack">${inner}</div>`;
const btns = (cancel = true) => `<div class="actions">${cancel ? '<span class="btn">Cancel</span>' : ''}<span class="btn primary">OK</span></div>`;
const long = 'Revoke access for deploy-bot?\n\nThis removes every grant deploy-bot holds on this workspace:\n• deploy to production and staging\n• read build and runtime logs\n• open and merge pull requests\n• rotate the webhook secret\n\nRunning jobs finish, queued jobs are dropped. Anyone using its token gets 401 from now on. You can grant access again later, but scopes have to be picked again by hand.\n\nAudit log entries stay. Webhooks it registered keep firing until you remove them under Settings → Webhooks.\n\nType the agent name on the next screen to confirm.';
const promptCard = (chip = '') => `<div class="card dialog">${head(chip)}<div class="msg">Agent name for the new grant</div>
    <div class="field focus"><span class="sel">deploy-bot</span></div>${btns()}</div>`;
const permCard = `<div class="card perm-card"><div class="head"><span class="fav">G</span><span class="origin">gateway.acme.io</span></div>
    <div class="msg">Wants permission for notifications</div>
    <div class="actions"><span class="btn">Block</span><span class="btn">Allow once</span><span class="btn primary">Allow</span></div></div>`;
export default {
  prompt: { veil: true, html: card(promptCard()) },
  confirm: { veil: true, html: card(`<div class="card dialog">${head()}<div class="msg">Revoke access for deploy-bot? It loses every grant on this workspace.</div>${btns()}</div>`) },
  alert: { veil: true, html: card(`<div class="card dialog">${head()}<div class="msg">Saved. ops-agent can now read this workspace.</div>${btns(false)}</div>`) },
  long: { veil: true, html: card(`<div class="card dialog">${head()}<div class="scroll"><div class="msg long">${long}</div><span class="sbar"></span></div>
    <div class="block"><span class="box"></span>Don’t let this page ask again</div>${btns()}</div>`) },
  queued: { veil: true, badge: [['Billing · Usage', ''], ['Docs · Grants API', '']],
    html: card(`<div class="card wait"><span class="dot"></span><span class="t"><b>2 tabs waiting:</b> Billing, Docs</span><span class="btn go">Show</span></div>
    ${permCard}${promptCard()}`) },
  // after the user clicks the frozen page: card nudges, focus ring on OK, a short-lived chip
  focus: { veil: true, html: card(`<div class="card dialog">${head('waiting for your answer')}<div class="msg">Agent name for the new grant</div>
    <div class="field">ops-agent</div>
    <div class="actions"><span class="btn">Cancel</span><span class="btn primary ring">OK</span></div></div>`) },
  // an agent request is blocked on this tab: the chip carries information, so it stays
  agent: { veil: true, html: card(`<div class="card dialog">${head('agent waiting')}<div class="msg">Revoke access for deploy-bot? It loses every grant on this workspace.</div>${btns()}</div>`) },
};
