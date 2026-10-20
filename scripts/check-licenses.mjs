import parse from 'spdx-expression-parse';

const allowed = new Set([
  'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC',
  'MPL-2.0', 'BlueOak-1.0.0', 'CC-BY-3.0', 'CC0-1.0',
]);
const reviewedExceptions = new Set([
  'OFL-1.1:@fontsource/rubik@5.3.0',
  'LGPL-3.0-or-later:@img/sharp-libvips-linux-x64@1.3.4',
  '0BSD:tslib@1.14.1',
  '0BSD:tslib@2.8.1',
  'Unlicense:isbot@5.2.2',
  'BSD:url-template@2.0.8',
  'MIT-0:postal-mime@4.0.11',
  'MIT-0:@csstools/color-helpers@6.1.2',
  'MIT-0:@csstools/css-syntax-patches-for-csstree@1.1.15',
]);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const report = JSON.parse(input);

function permitted(expression) {
  if (expression === 'BSD') return false;
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
    for (const pkg of packages) {
      for (const version of pkg.versions) {
        if (reviewedExceptions.has(`${license}:${pkg.name}@${version}`)) continue;
        console.error(`Unreviewed license ${license}: ${pkg.name}@${version}`);
        failed = true;
      }
    }
  }
}
if (failed) process.exitCode = 1;
