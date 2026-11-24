'use strict';

const chatForm = $('chatForm');
const chatInput = $('chatInput');
const chatPicker = $('chatImagePicker');
const chatDraft = $('chatImageDraft');
const chatPreview = $('chatImagePreview');
const chatHistory = $('messages');
const chatStart = chatHistory.firstElementChild.cloneNode(true);
const imageViewer = $('chatImageViewer');
const incomingImages = new Map();
const imageHistory = [];
let draftImage = null;
let draftRevision = 0;
let checkingImage = false;
let sendingImage = false;
let chatSession = 0;

function showChatImage(image) {
    $('chatImageFull').src = image.url;
    $('chatImageFull').alt = image.file.name;
    $('chatImageTitle').textContent = image.file.name;
    imageViewer.showModal();
}

function appendMessage(name, text, time = Date.now(), own = false, image = null) {
    const follow = own || chatHistory.scrollHeight - chatHistory.scrollTop - chatHistory.clientHeight < 32;
    chatHistory.querySelector('.chat-start')?.remove();
    const message = document.createElement('article');
    message.className = 'message';
    const title = document.createElement('span');
    title.className = 'message-author';
    title.textContent = name;
    const when = document.createElement('time');
    const date = new Date(time);
    when.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    message.append(title, when);
    if (text) {
        const body = document.createElement('p');
        body.textContent = text;
        message.append(body);
    }
    if (image) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'chat-image';
        button.setAttribute('aria-label', '放大图片 ' + image.file.name);
        button.onclick = () => showChatImage(image);
        const preview = document.createElement('img');
        preview.src = image.url;
        preview.alt = image.file.name;
        preview.width = image.width;
        preview.height = image.height;
        preview.loading = 'lazy';
        button.append(preview);
        message.append(button);
        imageHistory.push({ button, url: image.url });
        if (imageHistory.length > 20) {
            const old = imageHistory.shift();
            if ($('chatImageFull').src === old.url) imageViewer.close();
            URL.revokeObjectURL(old.url);
            const expired = document.createElement('p');
            expired.className = 'muted';
            expired.textContent = '图片预览已清理';
            old.button.replaceWith(expired);
        }
    }
    chatHistory.append(message);
    if (follow) chatHistory.scrollTop = chatHistory.scrollHeight;
}

function syncSendButton() {
    $('addChatImage').disabled = sendingImage;
    $('removeChatImage').disabled = sendingImage;
    $('sendMessage').disabled = sendingImage || checkingImage || (!draftImage && !chatInput.value.trim());
    $('chatImageProgress').hidden = !sendingImage && !checkingImage;
    $('chatImageProgress').textContent = sendingImage ? '正在发送图片…' : '正在读取图片…';
}

function showDraft(image = null) {
    draftImage = image;
    chatDraft.hidden = !image;
    if (image) {
        chatPreview.src = image.url;
        $('chatImageName').textContent = image.file.name;
    } else {
        chatPreview.removeAttribute('src');
        $('chatImageName').textContent = '';
    }
    syncSendButton();
}

function removeDraft() {
    if (draftImage) URL.revokeObjectURL(draftImage.url);
    showDraft();
}

async function attachChatImage(file) {
    if (!file || sendingImage) return;
    const revision = ++draftRevision;
    checkingImage = true;
    syncSendButton();
    try {
        const image = await FriendsChatImages.prepare(file, file.name);
        if (revision !== draftRevision) return URL.revokeObjectURL(image.url);
        removeDraft();
        showDraft(image);
        chatInput.focus();
    } catch (error) {
        if (revision === draftRevision) toast(error.message);
    } finally {
        if (revision === draftRevision) {
            checkingImage = false;
            syncSendButton();
        }
    }
}

$('addChatImage').onclick = () => chatPicker.click();
$('removeChatImage').onclick = () => {
    ++draftRevision;
    checkingImage = false;
    removeDraft();
    chatInput.focus();
};
chatPicker.onchange = () => {
    void attachChatImage(chatPicker.files[0]);
    chatPicker.value = '';
};
chatInput.addEventListener('paste', event => {
    const item = [...event.clipboardData.items].find(item => item.kind === 'file' && item.type.startsWith('image/'));
    if (!item) return;
    event.preventDefault();
    void attachChatImage(item.getAsFile());
});
chatForm.addEventListener('dragover', event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = sendingImage ? 'none' : 'copy';
});
chatForm.addEventListener('drop', event => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    event.stopPropagation();
    void attachChatImage(event.dataTransfer.files[0]);
});
imageViewer.addEventListener('close', () => $('chatImageFull').removeAttribute('src'));
chatInput.addEventListener('input', syncSendButton);

let confirmingComposition = false;
chatInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) {
        confirmingComposition = true;
        setTimeout(() => { confirmingComposition = false; }, 0);
    }
});

async function sendChatImage(image, text, time) {
    const connected = [...call.peers.values()].filter(peer => peer.channel?.readyState === 'open');
    const supported = connected.filter(peer => peer.chatImage);
    if (!supported.length) {
        toast(connected.length ? '朋友需要更新同屏才能接收图片。' : '朋友尚未连接，请稍后再发送图片。');
        return;
    }
    const session = chatSession;
    sendingImage = true;
    syncSendButton();
    try {
        const buffer = await image.file.arrayBuffer();
        if (session !== chatSession) return;
        const meta = { size: buffer.byteLength, mime: image.file.type, name: image.file.name, text, time };
        const sharing = display || [...peerState.values()].some(state => state.screen);
        const rate = (sharing ? 384 * 1024 : 1024 * 1024) / supported.length;
        const results = await Promise.allSettled(supported.map(async peer =>
            FriendsChatImages.send(call.openImageChannel(peer.id), buffer, meta, rate)));
        if (session !== chatSession) return;
        const sent = results.filter(result => result.status === 'fulfilled').length;
        if (!sent) return toast('图片没有发出，请检查连接后重试。');
        appendMessage(call.name, text, time, true, image);
        showDraft();
        if (chatInput.value.trim() === text) chatInput.value = '';
        if (sent < connected.length) toast('图片已发给 ' + sent + ' 人，部分成员未收到。');
    } finally {
        if (session === chatSession) {
            sendingImage = false;
            syncSendButton();
        }
    }
}

chatForm.onsubmit = event => {
    event.preventDefault();
    if (confirmingComposition || checkingImage || sendingImage) return;
    const text = chatInput.value.trim();
    const time = Date.now();
    if (draftImage) return void run(() => sendChatImage(draftImage, text, time), 'chat');
    if (!text) return;
    if (!call.sendData({ type: 'chat', text, time })) return toast('朋友尚未连上，消息没有发送。');
    appendMessage(call.name, text, time, true);
    chatInput.value = '';
    syncSendButton();
    chatInput.focus();
};

call.addEventListener('data', ({ detail: { name, data } }) => {
    if (data.type === 'chat' && typeof data.text === 'string') appendMessage(name, data.text.slice(0, 2000), data.time);
});
call.addEventListener('imagechannel', ({ detail: { id, name, channel } }) => {
    if (!call.peers.get(id)?.chatImage || incomingImages.has(id)) return channel.close();
    incomingImages.set(id, channel);
    FriendsChatImages.receive(channel, (image, meta) => {
        if (incomingImages.get(id) === channel) appendMessage(name, meta.text, meta.time, false, image);
        else URL.revokeObjectURL(image.url);
    }, () => {
        if (incomingImages.get(id) === channel) incomingImages.delete(id);
    });
});
call.addEventListener('peerleft', ({ detail: { id } }) => {
    incomingImages.get(id)?.close();
    incomingImages.delete(id);
});
call.addEventListener('left', () => {
    chatSession++;
    draftRevision++;
    checkingImage = sendingImage = false;
    removeDraft();
    if (imageViewer.open) imageViewer.close();
    for (const image of imageHistory.splice(0)) URL.revokeObjectURL(image.url);
    chatInput.value = '';
    chatHistory.replaceChildren(chatStart.cloneNode(true));
    syncSendButton();
});
