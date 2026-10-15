#!/usr/bin/env node
// Управление замерщиками: добавление, список, удаление.
//   npm run pin -- --name "Иван Петров" --pin 4321
//   npm run pin -- --list
//   npm run pin -- --delete "Иван Петров"
import * as auth from '../server/auth.js';

const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const name = value('--name') ?? value('-n');
const pin = value('--pin') ?? value('-p');
const deleteName = value('--delete') ?? value('-d');

try {
  if (args.includes('--list') || args.includes('-l')) {
    const users = auth.listUsers();
    if (!users.length) console.log('Замерщиков пока нет.');
    for (const user of users) {
      console.log(`  ${user.id.slice(0, 8)}  ${user.name.padEnd(24)} ${user.role}`);
    }
  } else if (deleteName) {
    auth.removeUser(deleteName);
    console.log(`Удалён: ${deleteName}`);
  } else if (name && pin) {
    const user = auth.addUser({ name, pin });
    console.log(`Добавлен замерщик: ${user.name} (PIN ${pin})`);
  } else {
    console.log('Использование:');
    console.log('  npm run pin -- --name "Иван" --pin 4321');
    console.log('  npm run pin -- --list');
    console.log('  npm run pin -- --delete "Иван"');
    process.exitCode = 1;
  }
} catch (error) {
  console.error('Ошибка:', error.message);
  process.exitCode = 1;
}