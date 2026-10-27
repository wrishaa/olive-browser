document.querySelector('#cancel').onclick = () => window.capturePicker.cancel();
window.capturePicker.get().then(data => {
  if (!data) return;
  document.querySelector('#origin').textContent = data.origin;
  for (const source of data.sources) {
    const button = document.createElement('button'), image = document.createElement('img'), label = document.createElement('span');
    image.src = source.thumbnail; image.alt = ''; label.textContent = source.name;
    button.append(image,label); button.onclick = () => { for (const b of document.querySelectorAll('button')) b.disabled = true; window.capturePicker.choose(source.id); };
    document.querySelector('#sources').append(button);
  }
});
