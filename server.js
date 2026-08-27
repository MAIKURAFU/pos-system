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

const members = {
  '0001': { id: '0001', name: '会員 0001', chips: 150 },
  '0002': { id: '0002', name: '会員 0002', chips: 50 },
  '0003': { id: '0003', name: '会員 0003', chips: 300 },
};

const products = [
  { id: 'p1', name: 'オリジナルアクスタ', price: 50, initialStock: 20, currentStock: 12 },
  { id: 'p2', name: '限定ステッカーセット', price: 10, initialStock: 50, currentStock: 15 },
  { id: 'p3', name: '記念缶バッジ', price: 20, initialStock: 30, currentStock: 2 },
  { id: 'p4', name: 'プレミアムTシャツ', price: 100, initialStock: 10, currentStock: 1 },
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
      member = { id: memberId, name: `新規会員 ${memberId}`, chips: 0 };
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

  // 在庫補充の処理
  socket.on('restock-item', ({ productId, amount }) => {
    const p = products.find(prod => prod.id === productId);
    if (p && amount > 0) {
      p.currentStock += amount;
      p.initialStock += amount; // 初期在庫（分母）も合わせて更新
      io.emit('data-updated', { member: null, products: getProductsWithStats() });
      socket.emit('toast-message', { message: `${p.name} の在庫を ${amount} 個追加しました` });
    }
  });

  socket.on('purchase-items', ({ memberId, cartItems }) => {
    const member = members[memberId];
    if (!member) return;

    let totalCost = 0;
    let stockError = false;

    cartItems.forEach(item => {
      const p = products.find(prod => prod.id === item.id);
      if (p) {
        if (p.currentStock < item.quantity) stockError = true;
        totalCost += p.price * item.quantity;
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

    io.emit('data-updated', { member, products: getProductsWithStats() });
    socket.emit('purchase-success', { message: '取引が完了しました' });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));