// @ts-check
import { escapeHtml } from '../lib/shared/html.js';

// Shared view primitives: status badges, priority pills, list rendering and the
// number/date/token/cost formatters used across the viewer pages. Pure string
// helpers (only escapeHtml). Extracted verbatim from server.js.

export function renderBadge(status) {
  const label = String(status || '').replace(/_/g, ' ');
  const indicator = isActiveStatus(status) ? '<i class="status-spinner"></i>' : '<i class="badge-dot"></i>';
  return `<span class="badge ${escapeHtml(statusClass(status))}">${indicator}${escapeHtml(label || '-')}</span>`;
}

export function statusClass(status) {
  return String(status || 'pending').toLowerCase().replace(/[^a-z0-9_-]+/g, '_') || 'pending';
}

export function isActiveStatus(status) {
  return ['running', 'executing', 'ejecutando', 'queued', 'started', 'generating', 'interpreting'].includes(statusClass(status));
}

export function renderPriorityBadge(value) {
  const meta = priorityMeta(value);
  return `<span class="priority-pill priority-${escapeHtml(meta.key)}">${escapeHtml(meta.label)}</span>`;
}

export function priorityMeta(value) {
  const normalized = String(value || 'media')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  const aliases = {
    low: 'baja',
    baja: 'baja',
    medium: 'media',
    media: 'media',
    high: 'alta',
    alta: 'alta',
    critical: 'critica',
    critica: 'critica',
    bloqueante: 'critica'
  };
  const key = aliases[normalized] || 'media';
  const labels = {
    baja: 'Baja',
    media: 'Media',
    alta: 'Alta',
    critica: 'Critica'
  };
  return { key, label: labels[key] || labels.media };
}

export function renderList(items, emptyText) {
  const values = (items || []).filter((item) => String(item || '').trim());
  if (!values.length) return `<p class="muted">${escapeHtml(emptyText)}</p>`;
  return `<ul class="detail-list">${values.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

export function formatSeconds(value) {
  const seconds = Number(value || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return '-';
  return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`;
}

export function formatTokens(value) {
  const number = Math.round(Number(value || 0));
  if (!Number.isFinite(number) || number <= 0) return '0';
  return String(number).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export function formatUsd(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'Sin estimar';
  const number = Number(value);
  const digits = number > 0 && number < 0.01 ? 6 : (number < 1 ? 4 : 2);
  return `USD ${number.toFixed(digits)}`;
}

export function shortDate(value) {
  const text = String(value || '');
  if (!text) return '-';
  return text.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
}
