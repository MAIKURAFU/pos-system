const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));

app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// 会員データ
const members = {
  '0001': { id: '0001', name: '会員 0001', chips: 150, history: [] },
  '0002': { id: '0002', name: '会員 0002', chips: 50, history: [] },
  '0003': { id: '0003', name: '会員 0003', chips: 300, history: [] },
};

// 商品リスト（ジャンル別）
const products = [
  // お菓子
  { id: 'snack1', category: 'お菓子', name: 'アルフォート', price: 10, initialStock: 50, currentStock: 50 },
  { id: 'snack2', category: 'お菓子', name: 'チョコまみれ', price: 10, initialStock: 50, currentStock: 50 },
  { id: 'snack3', category: 'お菓子', name: 'カントリーマーム', price: 10, initialStock: 50, currentStock: 50 },
  { id: 'snack4', category: 'お菓子', name: 'チョコクッキー', price: 10, initialStock: 50, currentStock: 50 },
  { id: 'snack5', category: 'お菓子', name: 'ちびポテト', price: 10, initialStock: 50, currentStock: 50 },
  { id: 'snack6', category: 'お菓子', name: 'おにぎりせんべい', price: 10, initialStock: 50, currentStock: 50 },
  { id: 'snack7', category: 'お菓子', name: 'キットカット', price: 10, initialStock: 50, currentStock: 50 },

  // ドリンク
  { id: 'drink1', category: 'ドリンク', name: 'お茶', price: 20, initialStock: 30, currentStock: 30 },
  { id: 'drink2', category: 'ドリンク', name: 'きっと果実', price: 20, initialStock: 30, currentStock: 30 },
  { id: 'drink3', category: 'ドリンク', name: 'ファンタ', price: 20, initialStock: 30, currentStock: 30 },
  { id: 'drink4', category: 'ドリンク', name: '午後ティー', price: 20, initialStock: 30, currentStock: 30 },
  { id: 'drink5', category: 'ドリンク', name: 'コーラ', price: 20, initialStock: 30, currentStock: 30 },

  // おもちゃ
  { id: 'toy1', category: 'おもちゃ', name: 'ピコピコハンマー', price: 50, initialStock: 20, currentStock: 20 },
  { id: 'toy2', category: 'おもちゃ', name: '風船ハンマー', price: 50, initialStock: 20, currentStock: 20 },
  { id: 'toy3', category: 'おもちゃ', name: 'ボール銃', price: 80, initialStock: 15, currentStock: 15 },
  { id: 'toy4', category: 'おもちゃ', name: 'ハンドスピナー', price: 60, initialStock: 20, currentStock: 20 },
  { id: 'toy5', category: 'おもちゃ', name: 'スクウィーズ', price: 40, initialStock: 20, currentStock: 20 },

  // イベント景品
  { id: 'event1', category: 'イベント景品', name: 'ポケモンカード', price: 100, initialStock: 10, currentStock: 10 },
  { id: 'event2', category: 'イベント景品', name: 'ワンピースカード', price: 100, initialStock: 10, currentStock: 10 },
  { id: 'event3', category: 'イベント景品', name: 'ガンダムプラモデル', price: 300, initialStock: 5, currentStock: 5 },
  { id: 'event4', category: 'イベント景品', name: 'イヤホン', price: 200, initialStock: 5, currentStock: 5 },
  { id: 'event5', category: 'イベント景品', name: 'アイラップ', price: 50, initialStock: 15, currentStock: 15 },
];

function getProductsWithStats() {
  return products.map(p => {
    const sold = p.initialStock - p.currentStock;
    const reductionRate = p.initialStock > 0 ? ((sold / p.initialStock) * 100).toFixed(1) : 0;
    return { ...p, sold, reductionRate };
  });
}

io.on('connection', (socket) => {
  socket.emit('init-data', { products: getProductsWithStats() });

  socket.on('scan-qr', (data) => {
    const memberId = data.memberId;
    let member = members[memberId];
    if (!member) {
      member = { id: memberId, name: `新規会員 ${memberId}`, chips: 0, history: [] };
      members[memberId] = member;
    }
    io.emit('member-scanned', { member });
  });

  socket.on('charge-chips', ({ memberId, amount }) => {
    if (members[memberId]) {
      members[memberId].chips += amount;
      io.emit('member-updated', { member: members[memberId] });
    }
  });

  socket.on('restock-item', ({ productId, amount }) => {
    const p = products.find(prod => prod.id === productId);
    if (p && amount > 0) {
      p.currentStock += amount;
      p.initialStock += amount;
      io.emit('data-updated', { member: null, products: getProductsWithStats() });
      socket.emit('toast-message', { message: `${p.name} の在庫を ${amount} 個追加しました` });
    }
  });

  // 商品設定（名前・必要チップ数・在庫数）の更新
  socket.on('update-product', ({ productId, name, price, currentStock }) => {
    const p = products.find(prod => prod.id === productId);
    if (p) {
      p.name = name;
      p.price = price;
      // 現在在庫に合わせて初期在庫（計算用）を自動調整
      if (currentStock > p.initialStock) {
        p.initialStock = currentStock;
      }
      p.currentStock = currentStock;

      io.emit('data-updated', { member: null, products: getProductsWithStats() });
      socket.emit('toast-message', { message: `${p.name} の設定を更新しました` });
    }
  });

  socket.on('purchase-items', ({ memberId, cartItems }) => {
    const member = members[memberId];
    if (!member) return;

    let totalCost = 0;
    let stockError = false;
    const purchasedSummary = [];

    cartItems.forEach(item => {
      const p = products.find(prod => prod.id === item.id);
      if (p) {
        if (p.currentStock < item.quantity) stockError = true;
        totalCost += p.price * item.quantity;
        purchasedSummary.push(`${p.name} × ${item.quantity}`);
      }
    });

    if (stockError) {
      socket.emit('error-message', { message: '在庫が不足している商品があります' });
      return;
    }

    if (member.chips < totalCost) {
      socket.emit('error-message', { message: 'チップが不足しています' });
      return;
    }

    member.chips -= totalCost;
    cartItems.forEach(item => {
      const p = products.find(prod => prod.id === item.id);
      if (p) {
        p.currentStock -= item.quantity;
      }
    });

    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    
    if (!member.history) member.history = [];
    member.history.unshift({
      time: timeStr,
      items: purchasedSummary.join(', '),
      cost: totalCost
    });

    io.emit('data-updated', { member, products: getProductsWithStats() });
    socket.emit('purchase-success', { message: '取引が完了しました' });
    io.emit('transaction-completed');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));