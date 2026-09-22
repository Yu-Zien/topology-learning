import { createEmptyCard, fsrs, Rating } from './vendor/ts-fsrs.mjs';

// The vendored file is the unmodified npm ts-fsrs@5.4.2 ESM distribution.
// Default parameters only: no training and no application-defined intervals.
export const SCHEDULER = Object.freeze({ name: 'ts-fsrs', version: '5.4.2', parameters: 'default' });
const scheduler = fsrs();
const serial = value => JSON.parse(JSON.stringify(value));

export function assertISO(value, label = '时间') {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label}必须是有效的 ISO 时间`);
  }
  return value;
}

function number(value, label, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${label}无效`);
  }
}

export function validateCard(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) throw new Error('复习卡片无效');
  assertISO(card.due, '卡片到期时间');
  if (card.last_review !== undefined) assertISO(card.last_review, '卡片上次复习时间');
  for (const key of ['stability', 'difficulty', 'elapsed_days', 'scheduled_days']) number(card[key], `卡片 ${key}`);
  for (const key of ['learning_steps', 'reps', 'lapses', 'state']) number(card[key], `卡片 ${key}`, true);
  if (card.state > 3 || card.difficulty > 10 || card.lapses > card.reps) throw new Error('复习卡片数值范围无效');
  if (card.reps > 0 && !card.last_review) throw new Error('已有评分的卡片缺少复习时间');
  return card;
}

export function validateLog(log) {
  if (!log || typeof log !== 'object' || Array.isArray(log)) throw new Error('FSRS 日志无效');
  if (![Rating.Again, Rating.Good].includes(log.rating)) throw new Error('FSRS 评分无效');
  assertISO(log.due, '日志到期时间');
  assertISO(log.review, '日志复习时间');
  for (const key of ['stability', 'difficulty', 'elapsed_days', 'last_elapsed_days', 'scheduled_days']) number(log[key], `日志 ${key}`);
  for (const key of ['state', 'learning_steps']) number(log[key], `日志 ${key}`, true);
  if (log.state > 3 || log.difficulty > 10) throw new Error('FSRS 日志数值范围无效');
  return log;
}

export function scheduleReview(previousCard, rating, nowISO) {
  assertISO(nowISO);
  if (!['again', 'good'].includes(rating)) throw new Error('评分只能是 again 或 good');
  if (previousCard) validateCard(previousCard);
  if (previousCard?.last_review && nowISO < previousCard.last_review) throw new Error('复习时间早于上次评分，请检查电脑时间');
  const now = new Date(nowISO);
  const card = previousCard ? {
    ...previousCard,
    due: new Date(previousCard.due),
    ...(previousCard.last_review ? { last_review: new Date(previousCard.last_review) } : {}),
  } : createEmptyCard(now);
  const result = serial(scheduler.next(card, now, rating === 'again' ? Rating.Again : Rating.Good));
  validateCard(result.card);
  validateLog(result.log);
  return result;
}
