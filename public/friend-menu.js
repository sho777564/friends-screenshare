'use strict';

const friendMenu = $('friendAvatarMenu');
const friendAction = $('friendAvatarAction');
const friendRequestDialog = $('friendRequestDialog');
const friendRemarkDialog = $('friendRemarkDialog');
const outgoingFriendRequests = new Map();
const requestLifetime = 60000;
const avatarSelector = '.avatar[data-friend-peer], .avatar[data-friend-id]';
let menuTarget = null;
let incomingFriendRequest = null;
let remarkTarget = null;

function refreshRoomContactNames() {
    let changed = false;
    for (const [id, item] of cards) {
        const peer = call.peers.get(id);
        if (!peer) continue;
        const label = displayPeerName(id, peer.name);
        if (item.username.textContent === label) continue;
        changed = true;
        item.username.textContent = item.placeholderName.textContent = label;
        for (const avatar of item.card.querySelectorAll(avatarSelector)) {
            avatar.textContent = Array.from(label)[0];
            bindFileTarget(avatar, id, label, true);
            avatar.title += ' · 右键管理好友';
        }
    }
    if (changed) renderMembers();
}

function closeFriendMenu(restoreFocus = false) {
    if (!friendMenu.matches(':popover-open')) return;
    friendMenu.hidePopover();
    if (restoreFocus && menuTarget?.avatar.isConnected) menuTarget.avatar.focus();
    menuTarget = null;
}

function openFriendMenu(avatar, x, y) {
    if (!phoneController) return;
    const peerId = avatar.dataset.friendPeer;
    const peer = call.peers.get(peerId);
    const identity = avatar.dataset.friendId || peer?.identity;
    if (!peer && !identity) return;
    const friend = phoneController.contacts.get(identity);
    if (!friend && !peer) return;
    menuTarget = { avatar, peerId, identity };
    $('friendActionIcon').innerHTML = icon(friend ? 'edit' : 'userPlus');
    $('friendActionLabel').textContent = friend ? '编辑备注' : outgoingFriendRequests.has(peerId) ? '已发送好友请求' : '添加好友';
    friendAction.disabled = !friend && outgoingFriendRequests.has(peerId);
    if (!friendMenu.matches(':popover-open')) friendMenu.showPopover();
    const bounds = friendMenu.getBoundingClientRect();
    friendMenu.style.left = Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)) + 'px';
    friendMenu.style.top = Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)) + 'px';
    (friendAction.disabled ? friendMenu : friendAction).focus();
}

document.addEventListener('contextmenu', event => {
    const avatar = event.target.closest(avatarSelector);
    if (!avatar) return;
    event.preventDefault();
    openFriendMenu(avatar, event.clientX, event.clientY);
});
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && friendMenu.matches(':popover-open')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeFriendMenu(true);
        return;
    }
    const avatar = event.target.closest(avatarSelector);
    if (!avatar) return;
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey) && !(avatar.dataset.friendId && ['Enter', ' '].includes(event.key))) return;
    event.preventDefault();
    const rect = avatar.getBoundingClientRect();
    openFriendMenu(avatar, rect.left, rect.bottom + 4);
}, true);
document.addEventListener('pointerdown', event => {
    if (!friendMenu.contains(event.target)) closeFriendMenu();
});
window.addEventListener('resize', () => closeFriendMenu());

function sendFriendRequest(peerId) {
    const peer = call.peers.get(peerId);
    if (!peer) return toast('对方已离开房间。');
    if (peer.channel?.readyState !== 'open') return toast('正在连接对方，请稍后再试。');
    if (!peer.friendRequests || !peer.identity) {
        openContactForm(peer.name);
        toast('请让朋友复制好友码，或让双方升级后直接添加。');
        return;
    }
    if (outgoingFriendRequests.has(peerId)) return;
    if (phoneController.contacts.size >= 16) return toast('联系人已满，最多保存 16 人。');
    const id = crypto.randomUUID();
    const sent = call.sendPeerData(peerId, { type: 'friend-request', action: 'offer', id, code: phoneController.code() });
    if (!sent) return toast('请求未发送，请稍后再试。');
    const timer = setTimeout(() => {
        outgoingFriendRequests.delete(peerId);
        closeFriendMenu();
        toast('好友请求已过期，可重新发送。');
    }, requestLifetime);
    outgoingFriendRequests.set(peerId, { id, identity: peer.identity, timer });
    toast('好友请求已发送。');
}

friendAction.onclick = () => {
    const target = menuTarget;
    closeFriendMenu();
    if (!target) return;
    const contact = phoneController.contacts.get(target.identity);
    if (!contact) return sendFriendRequest(target.peerId);
    remarkTarget = target;
    $('friendRemark').value = contact.name;
    friendRemarkDialog.showModal();
    $('friendRemark').select();
};

$('friendRemarkForm').onsubmit = event => {
    event.preventDefault();
    if (!remarkTarget) return;
    run(() => {
        const peerName = call.peers.get(remarkTarget.peerId)?.name;
        phoneController.rename(remarkTarget.identity, $('friendRemark').value, peerName);
        friendRemarkDialog.close();
        toast('备注已保存。');
    }, 'phone');
};
friendRemarkDialog.addEventListener('close', () => {
    if (remarkTarget?.avatar.isConnected) remarkTarget.avatar.focus();
    remarkTarget = null;
});

function readRoomFriend(code, peer) {
    if (!peer?.identity) return null;
    let candidate;
    try { candidate = FriendsPhone.readContact(code); }
    catch { return null; }
    if (candidate.id !== peer.identity || candidate.id === phoneController.self.id) return null;
    return candidate;
}

function clearIncoming(request) {
    if (incomingFriendRequest !== request) return;
    clearTimeout(request.timer);
    incomingFriendRequest = null;
    friendRequestDialog.close();
}

function answerFriendRequest(accept) {
    const request = incomingFriendRequest;
    if (!request || request.processing) return;
    request.processing = true;
    $('friendRequestAccept').disabled = true;
    $('friendRequestDecline').disabled = true;
    void run(async () => {
        try {
            if (accept) await phoneController.addRoomContact(request.code, request.identity);
            if (incomingFriendRequest !== request) return;
            const reply = { type: 'friend-request', action: 'answer', id: request.id };
            if (accept) reply.code = phoneController.code();
            const sent = call.sendPeerData(request.peerId, reply);
            if (accept) toast(sent ? '好友已添加。' : '好友已保存，对方已离开房间。');
        } catch (error) {
            call.sendPeerData(request.peerId, { type: 'friend-request', action: 'answer', id: request.id });
            throw error;
        } finally {
            clearIncoming(request);
        }
    }, 'phone');
}

$('friendRequestAccept').onclick = () => answerFriendRequest(true);
$('friendRequestDecline').onclick = () => answerFriendRequest(false);
friendRequestDialog.addEventListener('cancel', event => {
    event.preventDefault();
    answerFriendRequest(false);
});

async function receiveFriendRequest({ id: peerId, data }) {
    if (!phoneController || !data || data.type !== 'friend-request' || !/^[0-9a-f-]{36}$/i.test(data.id || '')) return;
    const peer = call.peers.get(peerId);
    if (!peer?.friendRequests || !peer.identity) return;
    if (data.action === 'offer') {
        if (incomingFriendRequest?.peerId === peerId && incomingFriendRequest.id === data.id) return;
        const contact = readRoomFriend(data.code, peer);
        if (!contact) return;
        if (incomingFriendRequest) {
            call.sendPeerData(peerId, { type: 'friend-request', action: 'answer', id: data.id });
            return;
        }
        const request = { peerId, id: data.id, code: data.code, identity: contact.id };
        request.timer = setTimeout(() => clearIncoming(request), requestLifetime);
        incomingFriendRequest = request;
        $('friendRequestText').textContent = displayPeerName(peerId, peer.name) + ' 想和你互加好友。';
        $('friendRequestDecline').disabled = false;
        $('friendRequestAccept').disabled = false;
        friendRequestDialog.showModal();
        return;
    }
    if (data.action !== 'answer') return;
    const request = outgoingFriendRequests.get(peerId);
    if (!request || request.id !== data.id || request.identity !== peer.identity) return;
    clearTimeout(request.timer);
    outgoingFriendRequests.delete(peerId);
    if (!data.code) return toast('对方未接受好友请求。');
    const candidate = readRoomFriend(data.code, peer);
    if (!candidate) return toast('好友身份不一致，请核对好友码。');
    await phoneController.addRoomContact(data.code, candidate.id);
    toast('好友已添加。');
}

call.addEventListener('data', ({ detail }) => {
    if (detail.data.type !== 'friend-request') return;
    receiveFriendRequest(detail).catch(error => toast(error.message));
});
call.addEventListener('peerleft', ({ detail: { id } }) => {
    clearTimeout(outgoingFriendRequests.get(id)?.timer);
    outgoingFriendRequests.delete(id);
    if (incomingFriendRequest?.peerId === id) clearIncoming(incomingFriendRequest);
    if (menuTarget?.peerId === id) closeFriendMenu();
});
