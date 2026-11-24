'use strict';
const iconPaths={mic:'<path d="M9 5a3 3 0 016 0v7a3 3 0 01-6 0z"/><path d="M5 10v2a7 7 0 0014 0v-2M12 19v3M8 22h8"/>',micOff:'<path d="M9 8V5a3 3 0 016 0v7M5 10v2a7 7 0 0012 5M19 10v2M12 19v3M8 22h8M3 3l18 18"/>',headphones:'<path d="M4 15v-3a8 8 0 0116 0v3M4 14h3v7H4a2 2 0 01-2-2v-3a2 2 0 012-2zM20 14h-3v7h3a2 2 0 002-2v-3a2 2 0 00-2-2z"/>',speaker:'<path d="M11 4L6 8H2v8h4l5 4zM16 8a6 6 0 010 8M19 4a11 11 0 010 16"/>',speakerOff:'<path d="M11 4L6 8H2v8h4l5 4zM16 9l6 6M22 9l-6 6"/>',screen:'<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 22h8M12 17v5M9 10l3-3 3 3M12 7v7"/>',stop:'<rect x="5" y="5" width="14" height="14" rx="2"/>',phone:'<path d="M3 12c4-5 14-5 18 0v5l-5-1v-3c-2-1-6-1-8 0v3l-5 1z"/>',gear:'<path d="M9 3h6l1 4 4 1v7l-4 1-1 5H9l-1-5-4-1V8l4-1z"/><circle cx="12" cy="12" r="3"/>',signal:'<path d="M4 20v-4M9 20v-8M14 20V8M19 20V3"/>',chat:'<path d="M4 3h16a2 2 0 012 2v12a2 2 0 01-2 2H9l-5 4v-4H3a2 2 0 01-2-2V5a2 2 0 012-2zM6 8h12M6 13h8"/>',users:'<circle cx="9" cy="8" r="4"/><path d="M1 22v-3a7 7 0 0114 0v3M17 5a4 4 0 010 7M19 16a6 6 0 014 6"/>',userPlus:'<circle cx="9" cy="8" r="4"/><path d="M1 22v-3a7 7 0 0114 0v3M19 8v8M15 12h8"/>',send:'<path d="M2 3l21 9-21 9 4-9zM6 12h17"/>',fullscreen:'<path d="M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6"/>'};
Object.assign(iconPaths, {
    edit: '<path d="m4 16-1 5 5-1L20 8l-4-4L4 16zM13 7l4 4"/>',
    screenOff: '<path d="M3 3l18 18M9 3h11a2 2 0 012 2v10M2 6v9a2 2 0 002 2h13M8 22h8M12 17v5"/>',
    play: '<path d="M8 5l11 7-11 7z"/>',
    winMin: '<path d="M3 12h18"/>',
    winMax: '<rect x="3" y="3" width="18" height="18"/>',
    winRestore: '<path d="M7 6V2h15v15h-4"/><rect x="2" y="7" width="15" height="15"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    file: '<path d="M14 2H5v20h14V7zM14 2v5h5M8 12h8M8 16h6"/>',
    arrowRight: '<path d="M4 12h16M14 6l6 6-6 6"/>',
    chevronDown: '<path d="M6 9l6 6 6-6"/>',
    keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M4 16v5h16v-5"/>'
});
function icon(name){return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(iconPaths[name]||iconPaths.speaker)+'</svg>';}
function icons(root=document){for(const node of root.querySelectorAll('[data-icon]'))node.innerHTML=icon(node.dataset.icon);}
icons();
