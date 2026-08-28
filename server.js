const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// 従業員IDリスト
const EMPLOYEE_IDS = ['従0001', '従0002', '従0003'];

// システムロック状態
let isLocked = false;

// 初期データ（商品）
let productsList = [
  { id: 'p1', name: 'うまい棒', category: 'お菓子', price: 10, currentStock: 50, initialStock: 50, reductionRate: 0 },
  { id: 'p2', name: 'ポテトチップス', category: 'お菓子', price: 30, currentStock: 20, initialStock: 20, reductionRate: 0 },
  { id: 'p3', name: '緑茶 500ml', category: 'ドリンク', price: 20, currentStock: 30, initialStock: 30, reductionRate: 0 },
  { id: 'p4', name: 'ミニカー', category: 'おもちゃ', price: 100, currentStock: 5, initialStock: 5, reductionRate: 0 }
];

// 初期データ（会員データ例）
let membersList = {
  'M001': { id: 'M001', name: '山田 太郎', chips: 150, history: [] },
  'M002': { id: 'M002', name: '佐藤 花子', chips: 300, history: [] }
};

let currentMemberId = null;

function calculateReductionRate(p) {
  if (!p.initialStock || p.initialStock <= 0) return 0;
  const rate = ((p.initialStock - p.currentStock) / p.initialStock) * 100;
  return Math.max(0, Math.min(100, Math.round(rate)));
}

io.on('connection', (socket) => {
  console.log('クライアントが接続しました:', socket.id);

  // 初期化データ送信（ロック状態も含める）
  socket.emit('init-data', {
    products: productsList,
    member: currentMemberId ? membersList[currentMemberId] : null,
    isLocked: isLocked
  });

  // システムロック処理
  socket.on('lock-system', () => {
    isLocked = true;
    currentMemberId = null; // スキャン中の会員解除
    io.emit('system-lock-status', { isLocked: true });
    io.emit('data-updated', {
      products: productsList,
      member: null
    });
  });

  // QRスキャン受信
  socket.on('scan-qr', (data) => {
    const { memberId } = data;

    // ロック中処理
    if (isLocked) {
      if (EMPLOYEE_IDS.includes(memberId)) {
        isLocked = false;
        io.emit('system-lock-status', { isLocked: false, message: 'システムロックを解除しました' });
        socket.emit('toast-message', { message: 'ロックを解除しました' });
      } else {
        socket.emit('error-message', { message: 'システムロック中です。従業員QRコードをスキャンしてください。' });
      }
      return;
    }

    // 従業員QRを通常スキャンした場合は通知
    if (EMPLOYEE_IDS.includes(memberId)) {
      socket.emit('toast-message', { message: '従業員QRコードです（ロック解除専用）' });
      return;
    }

    // 通常の会員スキャン処理
    if (membersList[memberId]) {
      currentMemberId = memberId;
      io.emit('member-scanned', { member: membersList[memberId] });
    } else {
      socket.emit('error-message', { message: '該当する会員が見つかりません: ' + memberId });
    }
  });

  // チップチャージ処理
  socket.on('charge-chips', (data) => {
    const { memberId, amount } = data;
    if (membersList[memberId]) {
      membersList[memberId].chips += amount;
      io.emit('member-updated', { member: membersList[memberId] });
      socket.emit('toast-message', { message: `${amount}チップをチャージしました` });
    }
  });

  // 交換（購入）処理
  socket.on('purchase-items', (data) => {
    const { memberId, cartItems } = data;
    const member = membersList[memberId];
    if (!member) return socket.emit('error-message', { message: '会員が存在しません' });

    let totalCost = 0;
    let purchaseSummaryList = [];

    for (let item of cartItems) {
      const prod = productsList.find(p => p.id === item.id);
      if (!prod) return socket.emit('error-message', { message: '存在しない商品が含まれています' });
      if (prod.currentStock < item.quantity) {
        return socket.emit('error-message', { message: `${prod.name} の在庫が不足しています` });
      }
      totalCost += prod.price * item.quantity;
      purchaseSummaryList.push(`${prod.name} × ${item.quantity}`);
    }

    if (member.chips < totalCost) {
      return socket.emit('error-message', { message: '所持チップが不足しています' });
    }

    member.chips -= totalCost;
    cartItems.forEach(item => {
      const prod = productsList.find(p => p.id === item.id);
      prod.currentStock -= item.quantity;
      prod.reductionRate = calculateReductionRate(prod);
    });

    const now = new Date();
    const timeStr = now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    member.history.unshift({
      time: timeStr,
      items: purchaseSummaryList.join(', '),
      cost: totalCost
    });

    currentMemberId = null;

    io.emit('data-updated', {
      products: productsList,
      member: null
    });

    socket.emit('purchase-success', { message: '景品の交換が完了しました！' });
  });

  // 在庫補充処理
  socket.on('restock-item', (data) => {
    const { productId, amount } = data;
    const prod = productsList.find(p => p.id === productId);
    if (prod) {
      prod.currentStock += amount;
      prod.initialStock = Math.max(prod.initialStock, prod.currentStock);
      prod.reductionRate = calculateReductionRate(prod);

      io.emit('data-updated', {
        products: productsList,
        member: currentMemberId ? membersList[currentMemberId] : null
      });
      io.emit('toast-message', { message: `${prod.name} の在庫を ${amount} 個補充しました` });
    }
  });

  // 商品編集処理
  socket.on('update-product', (data) => {
    const { productId, name, price, currentStock } = data;
    const prod = productsList.find(p => p.id === productId);
    if (prod) {
      prod.name = name;
      prod.price = price;
      prod.currentStock = currentStock;
      prod.initialStock = Math.max(prod.initialStock, currentStock);
      prod.reductionRate = calculateReductionRate(prod);

      io.emit('data-updated', {
        products: productsList,
        member: currentMemberId ? membersList[currentMemberId] : null
      });
      io.emit('toast-message', { message: `${name} の情報を更新しました` });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});