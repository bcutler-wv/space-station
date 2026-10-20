import http from 'node:http';
import { Buffer } from 'node:buffer';
import { setTimeout } from 'node:timers';

// This process runs only on a disposable CI network mapped to an apparently
// public address. It never contacts that address outside Docker.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgZGL+DwABFAEG9O6t0QAAAABJRU5ErkJggg==', 'base64');
const avif = Buffer.from('AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAAXBtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAADRpbG9jAAAAAERAAAIAAQAAAAABlAABAAAAAAAAAB8AAgAAAAABswABAAAAAAAAABQAAAA4aWluZgAAAAAAAgAAABVpbmZlAgAAAAABAABhdjAxAAAAABVpbmZlAgAAAAACAABhdjAxAAAAAA5waXRtAAAAAAABAAAAr2lwcnAAAACKaXBjbwAAAAxhdjFDgSACAAAAABRpc3BlAAAAAAAAAAIAAAACAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQAcAAAAAA5waXhpAAAAAAEIAAAAOGF1eEMAAAAAdXJuOm1wZWc6bXBlZ0I6Y2ljcDpzeXN0ZW1zOmF1eGlsaWFyeTphbHBoYQAAAAAdaXBtYQAAAAAAAAACAAEDgQIDAAIEhAIFhgAAABppcmVmAAAAAAAAAA5hdXhsAAIAAQABAAAAO21kYXQSAAoHOAA2kBDQaTISGUJjBMAANAAAkEDJHGFCsOCAEgAKBBgANhUyChgAAAEAAiEbo2A=', 'base64');
const pixelBomb = Buffer.from(png);
pixelBomb.writeUInt32BE(65_535, 16);
pixelBomb.writeUInt32BE(65_535, 20);
let crc = 0xffffffff;
for (const byte of pixelBomb.subarray(12, 29)) {
  crc ^= byte;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
}
pixelBomb.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
const calls = new Map();
const server = http.createServer((request, response) => {
  const path = request.url?.split('?')[0] ?? '/';
  calls.set(path, (calls.get(path) ?? 0) + 1);
  if (path === '/calls') {
    calls.set(path, (calls.get(path) ?? 1) - 1);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(Object.fromEntries(calls)));
  } else if (path === '/raster') {
    response.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
    response.end(png);
  } else if (path === '/avif') {
    response.writeHead(200, { 'content-type': 'image/avif', 'content-length': avif.length });
    response.end(avif);
  } else if (path === '/redirect') {
    response.writeHead(302, { location: 'http://raster.example.com/redirect-target' });
    response.end();
  } else if (path === '/redirect-target') {
    response.writeHead(200, { 'content-type': 'image/png' });
    response.end(png);
  } else if (path === '/bad') {
    response.writeHead(200, { 'content-type': 'image/png' });
    response.end('<svg onload="alert(1)"></svg>');
  } else if (path === '/bomb') {
    response.writeHead(200, { 'content-type': 'image/png' });
    response.end(pixelBomb);
  } else if (path === '/large') {
    response.writeHead(200, { 'content-type': 'image/png' });
    response.end(Buffer.alloc(4 * 1024 * 1024 + 1));
  } else if (path === '/slow') {
    setTimeout(() => { response.writeHead(200, { 'content-type': 'image/png' }); response.end(png); }, 7_000);
  } else { response.writeHead(404); response.end(); }
});
server.listen(80, '0.0.0.0');
