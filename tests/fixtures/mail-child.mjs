const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const mode = Buffer.concat(chunks).toString('utf8');
if (mode === 'hang') setInterval(() => {}, 1_000);
else if (mode === 'bad') process.stdout.write('{');
else if (mode === 'overflow') process.stdout.write('x'.repeat(16_777_217));
