const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// 静的ファイルの提供
app.use(express.static(path.join(__dirname, 'public')));

// システムロック初期状態（起動時はロック状態）
let isLocked = true;

// 会員データ
let members = [
  { id: '1001', name: '山田 太郎', chips: 150, history: [] },
  { id: '1002', name: '佐藤 花子', chips: 300, history: [] },
  { id: '1003', name: '鈴木 一郎', chips: 50, history: [] }
];

// 景品（商品）データ
let products = [
  { id: 'p1', name: 'ポテトチップス', category: 'お菓子', price: 10, currentStock: 20, initialStock: 20, reductionRate: 0 },
  { id: 'p2', name: '缶コーラ', category: 'ドリンク', price: 15, currentStock: 15, initialStock: 15, reductionRate: 0 },
  { id: 'p3', name: 'ミニカー', category: 'おもちゃ', price: 50, currentStock: 5, initialStock: 5, reductionRate: 0 },
  { id: 'p4', name: 'ぬいぐるみ', category: 'イベント景品', price: 100, currentStock: 2, initialStock: 2, reductionRate: 0 }
];

// 現在選択中の会員ID
let currentMemberId = null;

io.on('connection', (socket) => {
  // 初回接続時にデータを送信
  const currentMember = members.find(m => m.id === currentMemberId) || null;
  socket.emit('init-data', {
    products,
    isLocked,
    member: currentMember
  });

  // 初期ロック状態を通知
  socket.emit('system-lock-status', {
    isLocked,
    message: isLocked ? 'システムはロックされています' : 'システムは解除されています'
  });

  // 【iPhone / iPad】QRコードスキャン（会員選択専用）
  socket.on('scan-qr', (data) => {
    if (!data || !data.code) return;
    const code = data.code.trim();

    // システムロック中は会員QRの受付不可
    if (isLocked) {
      socket.emit('error-message', { message: 'システムがロックされています。画面からロック解除を行ってください。' });
      return;
    }

    // 会員コードの検索
    const member = members.find(m => m.id === code);
    if (member) {
      currentMemberId = member.id;
      io.emit('member-scanned', { member });
    } else {
      socket.emit('error-message', { message: '該当する会員が見つかりません' });
    }
  });

  // 【member_check.html 専用】残高照会（他端末へ非通知）
  socket.on('check-member-balance', (data) => {
    if (!data || !data.code) return;
    const code = data.code.trim();

    const member = members.find(m => m.id === code);
    if (member) {
      socket.emit('member-balance-result', { success: true, member });
    } else {
      socket.emit('member-balance-result', { success: false, message: '該当する会員が見つかりません' });
    }
  });

  // チップチャージ処理
  socket.on('charge-chips', (data) => {
    if (isLocked) return socket.emit('error-message', { message: 'システムがロックされています' });
    const member = members.find(m => m.id === data.memberId);
    if (member) {
      member.chips += data.amount;
      io.emit('member-updated', { member });
    }
  });

  // 景品交換（購入）処理
  socket.on('purchase-items', (data) => {
    if (isLocked) return socket.emit('error-message', { message: 'システムがロックされています' });

    const member = members.find(m => m.id === data.memberId);
    if (!member) return socket.emit('error-message', { message: '会員情報が見つかりません' });

    let totalCost = 0;
    const itemSummary = [];

    for (const item of data.cartItems) {
      const prod = products.find(p => p.id === item.id);
      if (!prod || prod.currentStock < item.quantity) {
        return socket.emit('error-message', { message: `${prod ? prod.name : '商品'}の在庫が足りません` });
      }
      totalCost += prod.price * item.quantity;
      itemSummary.push(`${prod.name} × ${item.quantity}`);
    }

    if (member.chips < totalCost) {
      return socket.emit('error-message', { message: 'チップ数が不足しています' });
    }

    member.chips -= totalCost;
    data.cartItems.forEach(item => {
      const prod = products.find(p => p.id === item.id);
      if (prod) {
        prod.currentStock -= item.quantity;
        prod.reductionRate = Math.round(((prod.initialStock - prod.currentStock) / prod.initialStock) * 100);
      }
    });

    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

    member.history.unshift({
      time: timeStr,
      items: itemSummary.join(', '),
      cost: totalCost,
      staffId: data.staffId || null
    });

    currentMemberId = null;

    socket.emit('purchase-success', { message: '交換が完了しました' });
    io.emit('data-updated', { member: null, products });
  });

  // 在庫補充
  socket.on('restock-item', (data) => {
    const prod = products.find(p => p.id === data.productId);
    if (prod) {
      prod.currentStock += data.amount;
      if (prod.currentStock > prod.initialStock) {
        prod.initialStock = prod.currentStock;
      }
      prod.reductionRate = Math.round(((prod.initialStock - prod.currentStock) / prod.initialStock) * 100);
      io.emit('data-updated', { member: members.find(m => m.id === currentMemberId) || null, products });
    }
  });

  // 商品情報更新
  socket.on('update-product', (data) => {
    const prod = products.find(p => p.id === data.productId);
    if (prod) {
      prod.name = data.name;
      prod.price = data.price;
      prod.currentStock = data.currentStock;
      if (prod.currentStock > prod.initialStock) prod.initialStock = prod.currentStock;
      prod.reductionRate = Math.round(((prod.initialStock - prod.currentStock) / prod.initialStock) * 100);
      io.emit('data-updated', { member: members.find(m => m.id === currentMemberId) || null, products });
    }
  });

  // 手動ロック切替（画面操作用）
  socket.on('lock-system', () => {
    isLocked = true;
    currentMemberId = null;
    io.emit('system-lock-status', { isLocked: true, message: '手動操作によりシステムがロックされました' });
    io.emit('data-updated', { member: null, products });
  });

  // 手動ロック解除（画面操作用）
  socket.on('unlock-system', () => {
    isLocked = false;
    io.emit('system-lock-status', { isLocked: false, message: 'ロックが解除されました' });
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});