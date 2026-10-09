// `@oms/contracts/testing`: what the contract tests and `contracts:freeze` need, and no
// service at run time. The only part of the package that reads files; `../index.ts` never
// imports it.
export { breakingChanges } from '../compatibility';
export { partyProblems } from '../parties';
export { bindingProblems, type Binding } from './bindings';
export { exampleOf } from './examples';
export {
  jsonSchemaOf,
  RELEASED_DIR,
  releasedFile,
  releasedKeys,
  releasedSample,
  releasedSchema,
} from './released';
