const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
	cors: { origin: true, credentials: true }
});

const frontendPath = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendPath));
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/ice-servers', (req, res) => {
	const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
	if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
		iceServers.push({
			urls: process.env.TURN_URL.split(',').map((url) => url.trim()),
			username: process.env.TURN_USERNAME,
			credential: process.env.TURN_CREDENTIAL
		});
	}
	res.json({ iceServers });
});
app.use((req, res, next) => {
	if (req.method === 'GET' && !path.extname(req.path)) {
		return res.sendFile(path.join(frontendPath, 'index.html'));
	}
	next();
});

const rooms = new Map();
const waitingQueues = new Map();

io.on('connection', (socket) => {
	socket.on('join-room', ({ roomId, name }) => {
		const cleanRoomId = String(roomId || '').trim().slice(0, 80);
		const cleanName = String(name || 'Guest').trim().slice(0, 40) || 'Guest';
		if (!cleanRoomId) return socket.emit('join-error', 'Enter a room name to continue.');

		const room = rooms.get(cleanRoomId);
		const isHost = !room || room.size === 0;

		if (isHost) {
			const newRoom = new Map();
			newRoom.set(socket.id, { name: cleanName, handRaised: false, isHost: true, role: 'host', state: 'approved', mediaState: { audioMuted: false, videoMuted: false } });
			rooms.set(cleanRoomId, newRoom);
			socket.join(cleanRoomId);
			socket.data.roomId = cleanRoomId;
			socket.data.name = cleanName;
			socket.data.state = 'approved';
			socket.emit('room-users', []);
			socket.emit('host-status', true);
			socket.emit('waiting-queue', []);
		} else {
			const waitingQueue = waitingQueues.get(cleanRoomId) || new Map();
			waitingQueue.set(socket.id, { name: cleanName, state: 'pending', socketId: socket.id });
			waitingQueues.set(cleanRoomId, waitingQueue);
			socket.data.roomId = cleanRoomId;
			socket.data.name = cleanName;
			socket.data.state = 'pending';
			socket.emit('waiting-room', { status: 'pending', message: 'Waiting for host to approve...' });
			const queueList = [...waitingQueue.entries()].map(([id, user]) => ({ id, ...user }));
			io.to(cleanRoomId).emit('waiting-queue', queueList);
		}
	});

	socket.on('host-action', ({ action, target }) => {
		const room = rooms.get(socket.data.roomId);
		const host = room?.get(socket.id);
		if (!room || !host?.isHost || !target) return;

		if (action === 'approve') {
			const waitingQueue = waitingQueues.get(socket.data.roomId);
			const pendingUser = waitingQueue?.get(target);
			if (pendingUser) {
				waitingQueue.delete(target);
				room.set(target, { name: pendingUser.name, handRaised: false, isHost: false, role: 'participant', state: 'approved', mediaState: { audioMuted: false, videoMuted: false } });
				rooms.set(socket.data.roomId, room);
				io.sockets.sockets.get(target).data.state = 'approved';
				io.to(target).emit('approval-granted');
				const peers = [...room.entries()].filter(([id]) => id !== target).map(([id, p]) => ({ id, ...p }));
				io.to(target).emit('room-users', peers);
				const queueList = [...waitingQueue.entries()].map(([id, user]) => ({ id, ...user }));
				io.to(socket.data.roomId).emit('waiting-queue', queueList);
				io.to(socket.data.roomId).emit('user-joined', { id: target, name: pendingUser.name });
			}
		} else if (action === 'reject') {
			const waitingQueue = waitingQueues.get(socket.data.roomId);
			if (waitingQueue?.has(target)) {
				waitingQueue.delete(target);
				io.to(target).emit('approval-rejected');
				io.sockets.sockets.get(target).disconnect(true);
				const queueList = [...waitingQueue.entries()].map(([id, user]) => ({ id, ...user }));
				io.to(socket.data.roomId).emit('waiting-queue', queueList);
			}
		} else if (action === 'remove') {
			if (!room.has(target) || target === socket.id) return;
			io.to(target).emit('removed-by-host');
			io.sockets.sockets.get(target)?.leave(socket.data.roomId);
			io.sockets.sockets.get(target)?.disconnect(true);
			room.delete(target);
			io.to(socket.data.roomId).emit('user-left', target);
		} else if (action === 'mute') {
			if (room.has(target)) io.to(target).emit('mute-request');
		} else if (action === 'give-presenter') {
			if (room.has(target)) {
				const participant = room.get(target);
				participant.role = participant.role === 'presenter' ? 'participant' : 'presenter';
				io.to(socket.data.roomId).emit('participant-role-changed', { id: target, role: participant.role });
			}
		}
	});

	socket.on('media-state', ({ audioMuted, videoMuted }) => {
		const roomId = socket.data.roomId;
		const room = rooms.get(roomId);
		const participant = room?.get(socket.id);
		if (!roomId || !participant) return;
		participant.mediaState = { audioMuted: Boolean(audioMuted), videoMuted: Boolean(videoMuted) };
		io.to(roomId).emit('participant-media-state', {
			id: socket.id,
			audioMuted: Boolean(audioMuted),
			videoMuted: Boolean(videoMuted)
		});
	});

	socket.on('signal', ({ target, signal }) => {
		if (target && signal) io.to(target).emit('signal', { sender: socket.id, signal });
	});

	socket.on('chat-message', (text) => {
		const roomId = socket.data.roomId;
		if (!roomId || typeof text !== 'string') return;
		const message = text.trim().slice(0, 1000);
		if (!message) return;
		io.to(roomId).emit('chat-message', {
			id: socket.id,
			name: socket.data.name || 'Guest',
			text: message,
			timestamp: Date.now()
		});
	});

	socket.on('hand-raise', (raised) => {
		const room = rooms.get(socket.data.roomId);
		if (!room || !room.has(socket.id)) return;
		room.get(socket.id).handRaised = Boolean(raised);
		io.to(socket.data.roomId).emit('hand-raise', { id: socket.id, raised: Boolean(raised) });
	});

	socket.on('ice-restart', ({ target }) => {
		if (target && socket.data.roomId) {
			io.to(target).emit('ice-restart-required', { from: socket.id });
		}
	});

	socket.on('recording-start', () => {
		const roomId = socket.data.roomId;
		const room = rooms.get(roomId);
		if (!room || !room.get(socket.id)?.isHost) return;
		io.to(roomId).emit('recording-started', { timestamp: Date.now() });
	});

	socket.on('recording-stop', () => {
		const roomId = socket.data.roomId;
		const room = rooms.get(roomId);
		if (!room || !room.get(socket.id)?.isHost) return;
		io.to(roomId).emit('recording-stopped', { timestamp: Date.now() });
	});

	socket.on('file-share-request', ({ to, filename, size }) => {
		io.to(to).emit('file-share-pending', { from: socket.id, fromName: socket.data.name, filename, size });
	});

	socket.on('file-share-approve', ({ from, filename }) => {
		io.to(from).emit('file-share-approved', { to: socket.id, filename });
	});

	socket.on('file-share-deny', ({ from, filename }) => {
		io.to(from).emit('file-share-denied', { to: socket.id, filename });
	});

	socket.on('file-chunk', ({ to, filename, chunk, chunkIndex, totalChunks }) => {
		io.to(to).emit('file-chunk', { from: socket.id, filename, chunk, chunkIndex, totalChunks });
	});

	socket.on('disconnect', () => {
		const roomId = socket.data.roomId;
		const room = rooms.get(roomId);
		const waitingQueue = waitingQueues.get(roomId);

		if (waitingQueue?.has(socket.id)) {
			waitingQueue.delete(socket.id);
			io.to(roomId).emit('waiting-queue', [...waitingQueue.entries()].map(([id, user]) => ({ id, ...user })));
		}

		if (!room) return;
		const wasHost = room.get(socket.id)?.isHost;
		room.delete(socket.id);

		if (wasHost && room.size > 0) {
			const [newHostId, newHost] = room.entries().next().value;
			newHost.isHost = true;
			newHost.role = 'host';
			io.to(newHostId).emit('host-status', true);
			io.to(roomId).emit('host-changed', newHostId);
		}

		socket.to(roomId).emit('user-left', socket.id);
		if (room.size === 0) {
			rooms.delete(roomId);
			waitingQueues.delete(roomId);
		}
	});
});


const port = Number(process.env.PORT) || 5000;
server.listen(port, '0.0.0.0', () => console.log(`Video meeting server running on port ${port}`));

