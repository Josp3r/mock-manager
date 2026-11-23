# Mock Manager 0.1.3 — design QA

- Source visual truth: `assets/design-target.png` (selected layout 1, palette 2).
- Rendered implementation: `docs/design/design-workbench.png` (real Electron app).
- Source size: 1584 × 992 image pixels, treated as 1584 × 992 CSS pixels.
- Implementation viewport: 1584 × 992 CSS pixels, native devicePixelRatio 2; Playwright `scale: 'css'` produces 1584 × 992 pixels. No crop, stretch, or zoom adjustment was applied.
- Additional viewports: 1440 × 940 and 1080 × 720 CSS pixels, recorded in `docs/design/preview-result.json`.
- State: 商城项目 → 商品列表 → 成功, 4 of 6 endpoints enabled, draft saved/pending Apply, isolated system-proxy fixture enabled. Previously applied error scenario remains active until Apply.

## Full-view comparison evidence

The source and actual rendered screenshot were opened together in a single comparison tool result, before and after the typography corrections. The comparison checked the whole window, the three-column proportions, sidebar, endpoint list, editor, topbar and footer. At 1584px the implemented columns are 236 / 338 / 1010px, matching the reference. The final response editor begins at approximately the reference's vertical position and retains its broad white code surface.

The complete 1584px images were readable at the inspection resolution, including the corrected M symbol, 16px code, scenario tabs, list switches and footer; additional region crops were not necessary. The compact window and settings dialog were also opened and inspected. Screenshots come from isolated test data, not the user's workspace.

## Comparison history

1. Initial capture: `docs/design/iteration-1.png`.
   - **P2 — text density too small:** list labels, scenario tabs and JSON appeared appreciably smaller than the selected design. Increased main text/code to 16px, headings and labels proportionally, and scene tabs to 112px minimum width. Adjusted editor heading gaps and padding to align the major regions.
   - **P2 — logo clipped:** the oversized raster mark participated in the grid's intrinsic sizing and clipped the right terminal. Positioned the same asset centrally inside its container.
2. Post-fix capture: `docs/design/design-workbench.png`; inspected together with the same source in one comparison result. Both issues resolved. Repeated interaction and containment checks at 1584, 1440 and 1080px passed.

## Findings

No unresolved P0/P1/P2 findings.

Intentional implementation differences preserve existing functionality and native desktop conventions:
- The topbar reserves 98px for macOS traffic-light controls, absent from the concept image. Page screenshots do not include native traffic lights.
- Project preset/edit/delete actions remain available as labeled icon buttons. Interface counts and module counts remain visible.
- Endpoint and scenario edit/delete actions remain explicit; their confirmations and keyboard labels are preserved.
- The footer retains the real local address, last applied time and Stop Mock action.
- The concrete `/products/101` example replaces the concept's `:id`, because routing currently uses exact matching.
- At 1080 × 720, the editor content and long JSON lines scroll within the editor; the topbar, three columns and statusbar remain visible. Long endpoint paths truncate with the full URL in a title.

## Interaction and runtime evidence

`node --import tsx scripts/design-preview.mjs` passed:
- Topbar proxy enable and graceful-quit restoration through the isolated helper, with no OS proxy or trust writes.
- Endpoint row switches save draft state without changing the selected endpoint or immediately changing applied responses.
- Success, empty and 500-error scenarios verified through real local HTTPS CONNECT using the exported CA.
- Invalid JSON blocks Apply and retains the previous working response.
- HTTP self-test, settings, empty state and invalid-JSON state rendered.
- No horizontal overflow or offscreen persistent topbar controls at any tested width.
- Renderer page errors: 0. Console errors: 0.

The existing desktop flow also passed with the final typography: project/endpoint CRUD, presets, draft persistence, close/quit flush, new nonexistent profile creation, real proxy application, and default-project layout at 1440 and 1080px. The system-proxy fixture suite passed cancellation, external-change conflict, restore after engine failure and quit/restart behavior. An independent code review found no remaining actionable regressions.

## Follow-up polish

- P3: Small icon shapes and subtle raster antialiasing differ from the generated concept. Production uses consistent Lucide controls and the generated brand asset.

final result: passed
