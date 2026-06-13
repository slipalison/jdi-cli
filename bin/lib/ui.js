'use strict';

// ANSI escape codes — sem deps externas
const isTTY = process.stdout.isTTY;
const supportsColor = isTTY && !process.env.NO_COLOR;
const supportsTrueColor =
  supportsColor &&
  (process.env.COLORTERM === 'truecolor' ||
    process.env.COLORTERM === '24bit' ||
    process.env.TERM_PROGRAM === 'vscode' ||
    process.env.WT_SESSION); // Windows Terminal

const c = {
  reset: supportsColor ? '\x1b[0m' : '',
  bold: supportsColor ? '\x1b[1m' : '',
  dim: supportsColor ? '\x1b[2m' : '',
  italic: supportsColor ? '\x1b[3m' : '',
  underline: supportsColor ? '\x1b[4m' : '',

  black: supportsColor ? '\x1b[30m' : '',
  red: supportsColor ? '\x1b[31m' : '',
  green: supportsColor ? '\x1b[32m' : '',
  yellow: supportsColor ? '\x1b[33m' : '',
  blue: supportsColor ? '\x1b[34m' : '',
  magenta: supportsColor ? '\x1b[35m' : '',
  cyan: supportsColor ? '\x1b[36m' : '',
  white: supportsColor ? '\x1b[37m' : '',
  gray: supportsColor ? '\x1b[90m' : '',

  bgBlue: supportsColor ? '\x1b[44m' : '',
  bgGreen: supportsColor ? '\x1b[42m' : '',
};

// Synthwave palette (truecolor with 256-color fallback)
function rgb(r, g, b, fallback256) {
  if (!supportsColor) return '';
  if (supportsTrueColor) return `\x1b[38;2;${r};${g};${b}m`;
  return `\x1b[38;5;${fallback256}m`;
}

const synthwave = {
  hotPink: rgb(255, 27, 141, 199),
  neonYellow: rgb(244, 241, 66, 227),
  cyanNeon: rgb(0, 255, 224, 51),
  magenta: rgb(255, 0, 200, 201),
  purple: rgb(185, 103, 255, 141),
};

// ASCII letters J D I in ANSI Shadow font (full glyphs, including J's hook)
const JDI_LETTERS = [
  '     ██╗██████╗ ██╗',
  '     ██║██╔══██╗██║',
  '     ██║██║  ██║██║',
  '██   ██║██║  ██║██║',
  '╚█████╔╝██████╔╝██║',
  ' ╚════╝ ╚═════╝ ╚═╝',
];

// 3 lightsabers stacked, right-anchored hilts, blades ignite leftward.
// Each saber: [blade plasma extending left]|=|◉|=|/////|==
//                                          ^^^ ^ ^^^ ^^^^^ ^^
//                                          emt btn grd grip pommel
const HILT_STR = '|=|◉|=|/////|==';        // composed hilt, right side
const HILT_LEN = 15;                        // visible length of HILT_STR
const BLADE_CHAR = '═';
const BLADE_MAX = 47;                       // blade extends this many chars left
const BLADE_TIP = '◄';                      // tip when fully ignited
const SABER_INDENTS = [2, 2, 2];            // aligned indents — hilts in same column
// Jedi blade palette — blue, green, purple
const SABER_COLORS_TRUE = [
  [46, 170, 251],   // Obi-Wan / Luke OG blue
  [55, 251, 58],    // Yoda / Luke ROTJ green
  [163, 72, 251],   // Mace Windu purple
];
const SABER_COLORS_256 = [33, 46, 129];
function saberColor(idx) {
  if (!supportsColor) return '';
  if (supportsTrueColor) {
    const [r, g, b] = SABER_COLORS_TRUE[idx];
    return `\x1b[38;2;${r};${g};${b}m`;
  }
  return `\x1b[38;5;${SABER_COLORS_256[idx]}m`;
}
const TAGLINE = 'Cut through the chaos. Ship the work. [Just do it]';

// Build one saber line, blade ignited from right (hilt) extending left to bladeChars.
// Layout (right-anchored): [spaces if blade incomplete][tip?][blade chars][hilt]
function buildSaberLine(saberIdx, bladeChars) {
  const yellow = synthwave.neonYellow;
  const red = supportsColor ? '\x1b[38;2;255;40;40m' : '';
  const bladeCol = saberColor(saberIdx);
  const r = c.reset;
  const hiltColor = `${yellow}${c.bold}`;
  const buttonColor = bladeChars > 0 ? `${red}${c.bold}` : hiltColor;

  // Indent (stagger) + leading spaces to keep hilt at fixed right column
  const indent = ' '.repeat(SABER_INDENTS[saberIdx]);
  const leftPad = ' '.repeat(Math.max(0, BLADE_MAX - bladeChars));

  let bladeSection = '';
  if (bladeChars > 0) {
    const tip = bladeChars >= BLADE_MAX ? `${bladeCol}${c.bold}${BLADE_TIP}${r}` : '';
    const bladeBody = bladeChars >= BLADE_MAX ? bladeChars - 1 : bladeChars;
    bladeSection = `${tip}${bladeCol}${c.bold}${BLADE_CHAR.repeat(bladeBody)}${r}`;
  }

  // HILT_STR has '◉' as 4th char (index 3). Recolor it red when blade active.
  // Render hilt in 3 segments to keep button distinct.
  const before = HILT_STR.slice(0, 3);    // |=|
  const button = HILT_STR.slice(3, 4);    // ◉
  const after = HILT_STR.slice(4);        // |=|/////|==
  const hilt =
    `${hiltColor}${before}${r}` +
    `${buttonColor}${button}${r}` +
    `${hiltColor}${after}${r}`;

  return `${indent}${leftPad}${bladeSection}${hilt}`;
}

function buildFrame({ showHilt, sabersBlade, showTagline }) {
  const pink = synthwave.hotPink;
  const purple = synthwave.purple;
  const r = c.reset;

  const lines = [''];

  // 6 rows of JDI letters in hot pink
  for (const row of JDI_LETTERS) {
    lines.push(`  ${pink}${c.bold}${row}${r}`);
  }

  lines.push('');

  // 3 stacked sabers
  if (showHilt) {
    for (let i = 0; i < 3; i++) {
      const blade = sabersBlade?.[i] ?? 0;
      lines.push(buildSaberLine(i, blade));
    }
  } else {
    lines.push('', '', '');
  }

  lines.push('');

  if (showTagline) {
    lines.push(`  ${purple}${c.italic}${TAGLINE}${r}`);
  } else {
    lines.push('');
  }
  lines.push('');

  return lines;
}

function moveCursorUp(n) {
  if (n > 0) process.stdout.write(`\x1b[${n}A`);
}
function clearLine() {
  process.stdout.write('\x1b[2K');
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeFrame(lines, isFirst) {
  if (!isFirst) {
    moveCursorUp(lines.length);
  }
  for (const line of lines) {
    clearLine();
    process.stdout.write(`\r${line}\n`);
  }
}

const wantsAnim =
  isTTY &&
  !process.env.NO_COLOR &&
  !process.env.CI &&
  process.env.JDI_ANIMATE !== 'off';

async function bannerAnimated() {
  // Non-TTY / CI / NO_COLOR: print static
  if (!wantsAnim) {
    banner();
    return;
  }

  // Cascade ignition: 3 sabers, each ignites with 80ms stagger.
  // Saber 0 (blue) at t=0, saber 1 (green) at t=80ms, saber 2 (purple) at t=160ms.
  // Each blade extends in 5 steps (~400ms per saber).
  const stepChars = [0, 12, 24, 36, 44, BLADE_MAX];

  function snapshot(t) {
    const result = [];
    for (let i = 0; i < 3; i++) {
      const elapsed = t - i * 80;
      if (elapsed <= 0) {
        result.push(0);
        continue;
      }
      const stepIdx = Math.min(stepChars.length - 1, Math.floor(elapsed / 80));
      result.push(stepChars[stepIdx]);
    }
    return result;
  }

  const frames = [];
  // t=0: letters only, no sabers. t=80: hilts appear (no blade)
  frames.push(
    { showHilt: false, sabersBlade: [0, 0, 0], showTagline: false, delay: 80 },
    { showHilt: true, sabersBlade: [0, 0, 0], showTagline: false, delay: 80 }
  );
  // Cascade ignition (~480ms)
  for (let t = 80; t <= 560; t += 80) {
    frames.push({ showHilt: true, sabersBlade: snapshot(t), showTagline: false, delay: 80 });
  }
  // Final: all blades full + tagline
  frames.push({
    showHilt: true,
    sabersBlade: [BLADE_MAX, BLADE_MAX, BLADE_MAX],
    showTagline: true,
    delay: 0,
  });

  let isFirst = true;
  for (const f of frames) {
    const lines = buildFrame(f);
    writeFrame(lines, isFirst);
    isFirst = false;
    if (f.delay > 0) await sleep(f.delay);
  }

  // Hold the banner for HOLD_MS so the user can see it before the command continues.
  // Use a small spinner under the tagline to signal that the CLI is alive and not frozen.
  const HOLD_MS = 5000;
  const SPIN_INTERVAL = 100;
  const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const purple = synthwave.purple;
  const r = c.reset;
  const start = Date.now();
  let spinIdx = 0;
  while (Date.now() - start < HOLD_MS) {
    const frame = SPIN_FRAMES[spinIdx % SPIN_FRAMES.length];
    process.stdout.write(`\r  ${purple}${frame}${r} ${c.dim}igniting...${r}   `);
    spinIdx++;
    await sleep(SPIN_INTERVAL);
  }
  // Clear the spinner line so command output starts cleanly
  process.stdout.write('\r' + ' '.repeat(40) + '\r');
}

function banner() {
  // Static one-shot — final state: all 3 sabers ignited + tagline
  const lines = buildFrame({
    showHilt: true,
    sabersBlade: [BLADE_MAX, BLADE_MAX, BLADE_MAX],
    showTagline: true,
  });
  console.log(lines.join('\n'));
}

// Box drawing
function box(title, lines, opts = {}) {
  const color = opts.color || c.cyan;
  const width = Math.max(
    title.length + 4,
    ...lines.map((l) => stripAnsi(l).length + 4),
    50
  );

  const top = `${color}╭${'─'.repeat(width - 2)}╮${c.reset}`;
  const bottom = `${color}╰${'─'.repeat(width - 2)}╯${c.reset}`;
  const titleLine = `${color}│${c.reset} ${c.bold}${title}${c.reset}${' '.repeat(width - 3 - title.length)}${color}│${c.reset}`;
  const sep = `${color}├${'─'.repeat(width - 2)}┤${c.reset}`;

  console.log(top);
  console.log(titleLine);
  console.log(sep);
  for (const line of lines) {
    const visibleLen = stripAnsi(line).length;
    const padding = ' '.repeat(Math.max(0, width - 3 - visibleLen));
    console.log(`${color}│${c.reset} ${line}${padding}${color}│${c.reset}`);
  }
  console.log(bottom);
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// Symbols
const sym = {
  success: `${c.green}✓${c.reset}`,
  error: `${c.red}✗${c.reset}`,
  warn: `${c.yellow}⚠${c.reset}`,
  info: `${c.cyan}ℹ${c.reset}`,
  arrow: `${c.cyan}→${c.reset}`,
  dot: `${c.gray}·${c.reset}`,
  bullet: `${c.cyan}●${c.reset}`,
};

// Step printers
function step(msg) {
  console.log(`${sym.arrow} ${msg}`);
}
function ok(msg) {
  console.log(`  ${sym.success} ${msg}`);
}
function fail(msg) {
  console.log(`  ${sym.error} ${c.red}${msg}${c.reset}`);
}
function warn(msg) {
  console.log(`  ${sym.warn} ${c.yellow}${msg}${c.reset}`);
}
function info(msg) {
  console.log(`  ${sym.info} ${c.dim}${msg}${c.reset}`);
}
function dim(msg) {
  console.log(`  ${c.gray}${msg}${c.reset}`);
}

function header(title) {
  console.log('');
  console.log(`${c.bold}${c.cyan}${title}${c.reset}`);
  console.log(`${c.gray}${'─'.repeat(Math.min(60, title.length + 10))}${c.reset}`);
}

function divider() {
  console.log(`${c.gray}${'─'.repeat(60)}${c.reset}`);
}

// Spinner
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function spinner(msg) {
  if (!isTTY) {
    console.log(`${sym.arrow} ${msg}...`);
    return {
      stop: () => { },
      success: (s) => ok(s || msg),
      fail: (s) => fail(s || msg),
    };
  }

  let i = 0;
  let active = true;
  const interval = setInterval(() => {
    if (!active) return;
    process.stdout.write(`\r${c.cyan}${SPINNER_FRAMES[i]}${c.reset} ${msg}   `);
    i = (i + 1) % SPINNER_FRAMES.length;
  }, 80);

  return {
    stop: () => {
      active = false;
      clearInterval(interval);
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
    },
    success: (s) => {
      active = false;
      clearInterval(interval);
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
      ok(s || msg);
    },
    fail: (s) => {
      active = false;
      clearInterval(interval);
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
      fail(s || msg);
    },
  };
}

// Pretty success summary box
function successSummary(title, lines) {
  console.log('');
  box(`${c.green}${title}${c.reset}`, lines, { color: c.green });
}

function errorSummary(title, lines) {
  console.log('');
  box(`${c.red}${title}${c.reset}`, lines, { color: c.red });
}

// Hint pra proximo passo
function nextSteps(steps) {
  console.log('');
  console.log(`${c.bold}${c.cyan}Proximos passos:${c.reset}`);
  for (let i = 0; i < steps.length; i++) {
    console.log(`  ${c.cyan}${i + 1}.${c.reset} ${steps[i]}`);
  }
  console.log('');
}

module.exports = {
  c,
  sym,
  synthwave,
  banner,
  bannerAnimated,
  box,
  step,
  ok,
  fail,
  warn,
  info,
  dim,
  header,
  divider,
  spinner,
  successSummary,
  errorSummary,
  nextSteps,
  stripAnsi,
};
