// tiny json file store with debounced atomic writes
const fs = require('fs');

class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.timer = null;
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.data = typeof defaults === 'function' ? defaults() : defaults;
    }
  }

  save(delay = 400) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[olive] store write failed', this.file, err);
    }
  }
}

module.exports = { JsonStore };
