import React from 'react';
import { createRoot } from 'react-dom/client';
import { PRODUCT_NAME } from '@station/shared';
import './style.css';

const mode = new URLSearchParams(window.location.search).get('theme') === 'dark' ? 'dark' : 'light';
document.documentElement.dataset.theme = mode;
document.title = PRODUCT_NAME;

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <main><h1>{PRODUCT_NAME}</h1><p>Foundation scaffold</p></main>
  </React.StrictMode>,
);
