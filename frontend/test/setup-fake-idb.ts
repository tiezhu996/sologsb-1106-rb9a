import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'

;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
;(globalThis as unknown as { IDBKeyRange: typeof IDBKeyRange }).IDBKeyRange = IDBKeyRange
