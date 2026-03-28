// Stub for the 'which' npm package.
// Prevents Bun from embedding process.env.PATH as a string literal in the
// compiled binary (Windows paths with \U, \W etc. break Bun's JS parser).
// Playwright only calls which() when no executablePath is given; we always
// provide one via chromium.executablePath(), so this is never reached.
function which(cmd) {
    return Promise.reject(Object.assign(new Error(`not found: ${cmd}`), { code: 'ENOENT' }));
}
which.sync = function (cmd) {
    throw Object.assign(new Error(`not found: ${cmd}`), { code: 'ENOENT' });
};
module.exports = which;
