const stack = document.querySelector('#stack');
window.permissions.on(items => {
  const ids = new Set(items.map(i => String(i.id)));
  for (const card of stack.children) if (!ids.has(card.dataset.id)) { card.classList.add('leaving'); setTimeout(() => card.remove(), 180); }
  for (const item of items) {
    if (stack.querySelector(`[data-id="${item.id}"]`)) continue;
    const card = document.createElement('article'); card.className = 'card'; card.dataset.id = item.id;
    const origin = document.createElement('strong'); origin.className = 'origin'; origin.textContent = item.origin; origin.title = item.origin;
    const text = document.createElement('p'); text.textContent = `Wants permission for ${item.label}`;
    const actions = document.createElement('div'); actions.className = 'actions';
    for (const [label, allow] of [['Deny', false], ['Allow', true]]) {
      const button = document.createElement('button'); button.textContent = label; if (allow) button.className = 'allow';
      button.onclick = () => { for (const b of actions.children) b.disabled = true; window.permissions.answer(item.id, allow); };
      actions.append(button);
    }
    card.append(origin, text, actions); stack.append(card);
  }
});
