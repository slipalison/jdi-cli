'use strict';

// ANSI escape codes — sem deps externas
const isTTY = process.stdout.isTTY;
const supportsColor = isTTY && !process.env.NO_COLOR;

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

// ASCII banner do JDI
const BANNER = [
  '',
  `${c.cyan}${c.bold}     ██╗██████╗ ██╗${c.reset}`,
  `${c.cyan}${c.bold}     ██║██╔══██╗██║${c.reset}`,
  `${c.cyan}${c.bold}     ██║██║  ██║██║${c.reset}`,
  `${c.cyan}${c.bold}██   ██║██║  ██║██║${c.reset}`,
  `${c.cyan}${c.bold}╚█████╔╝██████╔╝██║${c.reset}`,
  `${c.cyan}${c.bold} ╚════╝ ╚═════╝ ╚═╝${c.reset}`,
  '',
  `${c.dim}     Just Do It ${c.reset}${c.gray}— workflow enxuto, multi-runtime${c.reset}`,
  '',
];

function banner() {
  console.log(BANNER.join('\n'));
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
      stop: () => {},
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
  banner,
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
