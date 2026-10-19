import parse from 'spdx-expression-parse';

const allowed = new Set([
  'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC',
  'MPL-2.0', 'BlueOak-1.0.0', 'CC-BY-3.0', 'CC0-1.0',
]);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const report = JSON.parse(input);

function permitted(expression) {
  const tree = parse(expression);
  function visit(node) {
    if (node.license) return allowed.has(node.license) && !node.exception;
    return visit(node.left) && visit(node.right);
  }
  return visit(tree);
}

let failed = false;
for (const [license, packages] of Object.entries(report)) {
  if (!permitted(license)) {
    for (const pkg of packages) console.error(`Unreviewed license ${license}: ${pkg.name}@${pkg.versions.join(',')}`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
