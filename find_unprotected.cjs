const fs = require('fs');
const path = require('path');

const dir = 'C:/dsh-tavern/lib';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && !f.includes('bundle'));
for (const f of files) {
  const content = fs.readFileSync(path.join(dir, f), 'utf8');
  const lines = content.split('\n');
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let idx = -1;
    while ((idx = line.indexOf('.indexOf(', idx + 1)) !== -1) {
      // Check if this .indexOf is inside a guard like (xxx || '').indexOf(
      const prefix = line.substring(0, idx);
      const hasOrGuard = /\([^)]*\|\|/ .test(prefix);
      // also check if there is `&&` guarding right before
      const protectedSimple = /&&\s*[A-Za-z0-9_.]*\s*$/.test(prefix);
      if (!hasOrGuard) {
        console.log(f + ':' + (i + 1) + ': maybe-unprotected: ' + line.trim().substring(0, 140));
        found = true;
      }
    }
  }
  if (!found) console.log(f + ': all analyzable indexOf look protected');
}