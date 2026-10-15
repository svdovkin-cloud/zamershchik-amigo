// Заявки. Раньше лежали в orders.jsonl, теперь за интерфейсом db.js:
// локально — тот же файл, на Render — таблица orders в Supabase.

import { readOrders, appendOrder, updateOrder, nextOrderNumber, findOrder } from './db.js';

export { readOrders, appendOrder, updateOrder, nextOrderNumber, findOrder };
