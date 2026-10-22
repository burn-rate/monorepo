import type { QuestDefinition } from './types';

/**
 * Stand up after sitting through most of the last hour.
 *
 * `stand_time` is stored as one-minute buckets, so a threshold of 5 minutes
 * over a rolling 60 means the user has been sitting for at least 55 of the
 * last 60 minutes.
 */
export const STAND_UP_QUEST: QuestDefinition = {
  id: 'stand-up',
  title: 'Stand up',
  description: 'You have been sitting almost the whole last hour. Stand and move for a minute.',
  trigger: { windowMinutes: 60, metric: 'stand_time', thresholdMinutes: 5 },
  completion: { metric: 'stand_time', minutes: 1, windowMinutes: 30 },
  rewardKcal: 25
};

/**
 * Break a sedentary stretch: fewer than 5 active minutes in the last 2 hours.
 * Completion asks for 5 brisk minutes within 30 minutes of the offer.
 */
export const MOVE_FIVE_MINUTES_QUEST: QuestDefinition = {
  id: 'move-five-minutes',
  title: 'Move for five minutes',
  description: 'No real movement in two hours. Take a five-minute break and get moving.',
  trigger: { windowMinutes: 120, metric: 'exercise_time', thresholdMinutes: 5 },
  completion: { metric: 'exercise_time', minutes: 5, windowMinutes: 30 },
  rewardKcal: 75
};

export const QUEST_DEFINITIONS = {
  'stand-up': STAND_UP_QUEST,
  'move-five-minutes': MOVE_FIVE_MINUTES_QUEST
} as const;

export type QuestDefinitionId = keyof typeof QUEST_DEFINITIONS;
