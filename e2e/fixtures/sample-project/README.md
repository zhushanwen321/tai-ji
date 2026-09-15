# sample-project

E2E fixture project for the taiji 文件树 (file-tree) rendering tests.

This directory simulates a minimal but realistic project structure so the
file-tree panel (W8) has deterministic top-level nodes to render:

```
sample-project/
├── package.json
├── README.md
├── tsconfig.json
├── src/
│   ├── index.ts
│   └── utils/
│       └── format.ts
└── tests/
    └── basic.test.ts
```

Do not delete or restructure without updating `e2e/file-tree.spec.ts` (W8).
