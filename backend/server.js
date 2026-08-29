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

io.on('connection', (socket) => {
	socket.on('join-room', ({ roomId, name }) => {
		const cleanRoomId = String(roomId || '').trim().slice(0, 80);
		const cleanName = String(name || 'Guest').trim().slice(0, 40) || 'Guest';
		if (!cleanRoomId) return socket.emit('join-error', 'Enter a room name to continue.');

		const room = rooms.get(cleanRoomId) || new Map();
		const isHost = room.size === 0;
		const peers = [...room.entries()].map(([id, participant]) => ({ id, ...participant }));
		room.set(socket.id, { name: cleanName, handRaised: false, isHost });
		rooms.set(cleanRoomId, room);
		socket.join(cleanRoomId);
		socket.data.roomId = cleanRoomId;
		socket.data.name = cleanName;

		socket.emit('room-users', peers);
		socket.emit('host-status', isHost);
		socket.to(cleanRoomId).emit('user-joined', { id: socket.id, name: cleanName });
	});

	socket.on('host-action', ({ action, target }) => {
		const room = rooms.get(socket.data.roomId);
		const host = room?.get(socket.id);
		if (!room || !host?.isHost || !target || !room.has(target) || target === socket.id) return;
		if (action === 'remove') {
			io.to(target).emit('removed-by-host');
			io.sockets.sockets.get(target)?.leave(socket.data.roomId);
			io.sockets.sockets.get(target)?.disconnect(true);
		} else if (action === 'mute') {
			io.to(target).emit('mute-request');
		}
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

	socket.on('disconnect', () => {
		const roomId = socket.data.roomId;
		const room = rooms.get(roomId);
		if (!room) return;
		const wasHost = room.get(socket.id)?.isHost;
		room.delete(socket.id);
		if (wasHost && room.size > 0) {
			const [newHostId, newHost] = room.entries().next().value;
			newHost.isHost = true;
			io.to(newHostId).emit('host-status', true);
			io.to(roomId).emit('host-changed', newHostId);
		}
		socket.to(roomId).emit('user-left', socket.id);
		if (room.size === 0) rooms.delete(roomId);
	});
});

const port = Number(process.env.PORT) || 5000;
server.listen(port, '0.0.0.0', () => console.log(`Video meeting server running on port ${port}`));

