'use strict';

module.exports = function miniWindow(window, screen) {
    let previous = null;
    function set(enabled) {
        const win = window();
        if (!win || win.isDestroyed()) return false;
        if (enabled && !previous) {
            previous = { bounds: win.getNormalBounds(), maximized: win.isMaximized() };
            if (previous.maximized) win.unmaximize();
            const area = screen.getDisplayMatching(win.getBounds()).workArea;
            const width = Math.min(640, area.width);
            const height = Math.min(520, area.height);
            win.setMinimumSize(420, 360);
            win.setBounds({ x: area.x + area.width - width - 16, y: area.y + area.height - height - 16, width, height });
            win.setAlwaysOnTop(true, 'floating');
        } else if (!enabled && previous) {
            const saved = previous;
            previous = null;
            win.setAlwaysOnTop(false);
            win.setMinimumSize(1000, 680);
            win.setBounds(saved.bounds);
            if (saved.maximized) win.maximize();
        }
        win.webContents.send('desktop:mini-changed', !!previous);
        return !!previous;
    }
    return { set, get active() { return !!previous; } };
};
