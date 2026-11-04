// Karyon's system prompt, tool, and the scene library it can paint.
// The scene names here must match the scenes in public/assets/ascii.js.
import PERSONA from '../../karyon/persona.txt';
import CONTEXT from '../../karyon/context.txt';

export const SCENES = {
  eyes: "Karyon's own two eyes, the home view. Greetings, questions about Karyon itself or CEV, what this site is, or when nothing else fits.",
  horizon: 'A small figure sitting on a cliff edge, watching the sun come up over a vast horizon. Philosophy, The Code, meaning, reflection, the long view.',
  planet: 'A ringed planet with orbiting satellites and habitats. Diversified Utopia, the far future, space, civilization at scale.',
  eclipse: 'A total solar eclipse with a streaming corona. The era of intelligence, the AI transition, superintelligence, timelines, risk, endings and beginnings.',
  galaxy: 'A golden-ratio spiral galaxy with seven bright stars joined into a constellation. Convergence and its seven steps, goals, direction, planning.',
  fire: 'A rune circle with a column of fire and rising embers. Staravorix, magic systems, fiction, worldbuilding, storytelling.',
  gears: 'A tree whose canopy is interlocking, turning gears. Vintage Story mods, Rustfall, modding, game systems, engineering.',
  network: 'A neural network with signals flowing through it and a lens examining it. Alignment research, PrefDecay-Eval, evals, agents, Apart Research, ML.',
  fireworks: 'Fireworks bursting over a child sitting in a dark field. Childhood, origins, wonder, bedtime stories, why he makes beautiful things.',
  meadow: 'Two figures walking a winding path through hills at dusk, with fireflies. Romance and ramblings, everyday life, walks, what makes a day good.',
  seed: 'A seed sprouting into a branching tree with roots. Growth, practice, self-improvement, Life Leveling, FitFight, the meaning of the name Karyon.',
  city: 'A skyline being built by a swarm of small drones. Things he has built, games, startups, fast-email.ai, consulting, Civilization Sim, CommunityVR.',
  library: 'An endless corridor of towering bookshelves leading toward light. Learning, reading, writing, Grinnell, research methods, recommended resources.',
  lanterns: 'Sky lanterns rising over water from a crowd on the shore. Community, effective altruism, hope, his talks, "You are part of the Good Future".',
  custom: 'Your own drawing, given as SVG in the svg field. Only for a specific subject none of the scenes above fits.',
};
export const SCENE_NAMES = Object.keys(SCENES);

const sceneList = SCENE_NAMES.map((name) => `- ${name}: ${SCENES[name]}`).join('\n');

export const PAINT_TOOL = {
  name: 'paint_background',
  description:
    'Morph the gold-on-black ASCII artwork beside the conversation into a new scene. The visitor watches ' +
    'it change while you talk. Visitors can draw on a painting, and clicking your eyes clears it. Choose "eyes" to clear the painting yourself. Call it at the start of a reply when the topic moves to something a ' +
    'different scene fits better, then write your reply. Skip it when the current scene already fits. ' +
    'At most one call per reply.\n\nScenes:\n' +
    sceneList +
    '\n\nFor "custom", draw an SVG: viewBox="0 0 160 90", a black background, and only white and grey ' +
    'shapes (they become brightness). Use bold filled silhouettes and thick strokes (stroke-width 1.5 or ' +
    'more), one clear subject, no text, no images, no scripts or links, and under 4,000 characters.',
  input_schema: {
    type: 'object',
    properties: {
      scene: { type: 'string', enum: SCENE_NAMES, description: 'Which scene to show.' },
      caption: {
        type: 'string',
        description: 'Two to five words shown faintly beside the art, e.g. "Diversified Utopia". Optional.',
      },
      svg: { type: 'string', description: 'Only for scene "custom": the full <svg>...</svg> markup.' },
    },
    required: ['scene'],
    additionalProperties: false,
  },
  // Stream the input as it is generated (an SVG can be a few thousand
  // characters). The API then skips validation, so validatePaint() does it.
  eager_input_streaming: true,
};

export const EXPRESSIONS = {
  wide: 'Your default: open and attentive.',
  focused: 'Narrowed in concentration, for a hard or serious question.',
  suspicious: 'One eye narrowed, for a message that seems to be testing or tricking you.',
  warm: 'Smiling eyes, for something kind, funny, or delightful.',
  surprised: 'Wide open, for something you did not expect.',
};
const EXPRESSION_NAMES = Object.keys(EXPRESSIONS);

export const EYES_TOOL = {
  name: 'set_eyes',
  description:
    'Change the expression of your two eyes, which the visitor can see. It lasts until their next message. ' +
    'Call it before you write your reply, and only when your expression should differ from the default. ' +
    'Your eyes already narrow on their own while you think.\n\nExpressions:\n' +
    EXPRESSION_NAMES.map((name) => `- ${name}: ${EXPRESSIONS[name]}`).join('\n'),
  input_schema: {
    type: 'object',
    properties: { expression: { type: 'string', enum: EXPRESSION_NAMES } },
    required: ['expression'],
    additionalProperties: false,
  },
};

export const END_TOOL = {
  name: 'end_conversation',
  description:
    'End this conversation with a lightning strike and stop talking with this visitor for a while (a day the ' +
    'first time, longer if it happens again). The chat is replaced by a static page about Michael. Michael reads ' +
    'every use. First write one short, calm last line to the visitor, then call this. Only use it as the rules in ' +
    'your instructions allow.',
  input_schema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'For Michael, not the visitor: one sentence on why you ended it.' },
    },
    required: ['reason'],
    additionalProperties: false,
  },
};

export function validateEyes(input) {
  const expression = input?.expression;
  return EXPRESSION_NAMES.includes(expression) ? { ok: true, value: { expression } } : { ok: false, error: `expression must be one of: ${EXPRESSION_NAMES.join(', ')}` };
}

export function validateEnd(input) {
  const reason = typeof input?.reason === 'string' ? input.reason.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
  return reason ? { ok: true, value: { reason } } : { ok: false, error: 'reason must be a non-empty string' };
}

export const SYSTEM = [
  {
    type: 'text',
    text: `${PERSONA.trim()}\n\n# Michael's context\n\n${CONTEXT.trim()}\n`,
    // Cached across all visitors: the prompt is identical for everyone.
    cache_control: { type: 'ephemeral' },
  },
];

const MAX_SVG = 8000;
const BAD_SVG = /<\s*script|<\s*foreignObject|\bon[a-z]+\s*=|javascript:|href\s*=|<\s*image|<\s*iframe|@import|url\s*\(\s*['"]?\s*(?:https?:|data:|\/\/)/i;

// Validates a paint_background input. Returns { ok, value } or { ok: false, error }.
export function validatePaint(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'input must be an object' };
  const { scene, caption, svg } = input;
  if (!SCENE_NAMES.includes(scene)) return { ok: false, error: `scene must be one of: ${SCENE_NAMES.join(', ')}` };
  const value = { scene };
  if (caption !== undefined) {
    if (typeof caption !== 'string') return { ok: false, error: 'caption must be a string' };
    const c = caption.replace(/\s+/g, ' ').trim().slice(0, 48);
    if (c) value.caption = c;
  }
  if (scene === 'custom') {
    if (typeof svg !== 'string' || !/^\s*<svg[\s>]/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) {
      return { ok: false, error: 'custom needs svg: a complete <svg>...</svg> document' };
    }
    if (svg.length > MAX_SVG) return { ok: false, error: `svg is too long (${svg.length} > ${MAX_SVG} characters)` };
    if (BAD_SVG.test(svg)) return { ok: false, error: 'svg may not contain scripts, event handlers, links, or images' };
    value.svg = svg.trim();
  }
  return { ok: true, value };
}

// Mid-conversation system message sent after the visitor's message each turn.
export function harnessNote({ scene, turn, maxTurns, day }) {
  const left = Math.max(0, maxTurns - turn);
  return (
    `Harness note (not from the visitor): the background currently shows "${scene}". ` +
    `This is visitor message ${turn} of at most ${maxTurns} in this conversation` +
    (left <= 3 ? `, so there are only ${left} left; it's fine to let them know they can start a new conversation.` : '.') +
    ` Today is ${day}.`
  );
}
