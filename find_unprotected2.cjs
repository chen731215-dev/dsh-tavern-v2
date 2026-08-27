const fs = require('fs');
const path = require('path');

const dir = 'C:/dsh-tavern/lib';
const targetFiles = ['client.manager.bundle.js', 'client.js', 'client.bundle.js'];
for (const f of targetFiles) {
  const fp = path.join(dir, f);
  if (!fs.existsSync(fp)) { console.log(f + ': NOT FOUND'); continue; }
  const content = fs.readFileSync(fp, 'utf8');
  const lines = content.split('\n');
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let idx = -1;
    while ((idx = line.indexOf('.indexOf(', idx + 1)) !== -1) {
      const prefix = line.substring(0, idx);
      // protected if there's (xxx || ...  pattern before .indexOf
      // Find the last '(' before idx and check for || inside
      const lastOpen = prefix.lastIndexOf('(');
      const hasOrGuard = lastOpen !== -1 && prefix.indexOf('||', lastOpen) !== -1 && prefix.indexOf(')', prefix.indexOf('||', lastOpen)) > idx;
      // protected if there's `&& xxx.index` direct guard
      const beforeSpace = prefix.replace(/\s+$/, '');
      const hasAndGuard = /&&\s*[A-Za-z0-9_.]*$/.test(beforeSpace);
      if (!hasOrGuard && !hasAndGuard) {
        console.log(f + ':' + (i + 1) + ': maybe-unprotected: ' + line.trim().substring(0, 150));
        found = true;
      }
    }
  }
  if (!found) console.log(f + ': all indexOf look protected');
}