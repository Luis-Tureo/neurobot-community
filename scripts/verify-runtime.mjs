const minimum = [24, 18, 1];
const current = process.versions.node.split('.').map((part) => Number(part));
const [major = 0, minor = 0, patch = 0] = current;

const atLeastMinimum =
  major > minimum[0] ||
  (major === minimum[0] &&
    (minor > minimum[1] || (minor === minimum[1] && patch >= minimum[2])));

if (major !== 24 || !atLeastMinimum) {
  console.error(
    [
      '',
      `Node.js incompatible: ${process.versions.node}.`,
      'Neurobot Community requiere Node.js 24.18.1 LTS o una versión posterior de la línea 24.x.',
      'En Windows ejecuta: npm run node:update:windows',
      'Después cierra y vuelve a abrir PowerShell.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

console.log(`Node.js ${process.versions.node} compatible con Neurobot Community.`);
