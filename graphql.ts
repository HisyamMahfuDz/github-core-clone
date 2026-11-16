// A small GraphQL implementation for the forge: a tokenizer and recursive-descent
// parser for the query language, plus an executor over the same store the REST
// surface uses. It covers the documents the conformance suite sends — operations,
// variables, aliases, arguments (including lists, input objects and enums),
// inline and named fragments, directives, __typename and __type introspection —
// and answers unknown fields with a 200 carrying an `errors` array, as the
// suite requires. No GraphQL library is used; this is original code.

import { branchTip, ForgeError, pullFiles, pullMergeable, squashMerge } from './forge.ts';
import {
  commentGlobalId,
  decodeGlobalId,
  issueGlobalId,
  pullGlobalId,
  repoByDatabaseId,
  repositoryGlobalId,
  userGlobalId,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import {
  b64urlDecode,
  b64urlEncode,
  forgeTimestamp,
  isRecord,
  VIEWER_ID,
  VIEWER_LOGIN,
} from './util.ts';

// ---------------------------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------------------------

export class GraphQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLError';
  }
}

// ---------------------------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
}

const PUNCTUATORS = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}', '.']);

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  const isDigit = (c: string): boolean => /[0-9]/.test(c);
  while (i < n) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < n && source[i] !== '\n' && source[i] !== '\r') i += 1;
      continue;
    }
    if (c === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCTUATORS.has(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new GraphQLError('Unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < n && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < n) {
          const esc = source[j + 1]!;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === 'u' && j + 5 < n) {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else value += esc;
          j += 2;
          continue;
        }
        value += source[j];
        j += 1;
      }
      if (j >= n) throw new GraphQLError('Unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (isDigit(c) || (c === '-' && isDigit(source[i + 1] ?? ''))) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < n && isDigit(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && isDigit(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < n && isDigit(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        let k = j + 1;
        if (source[k] === '+' || source[k] === '-') k += 1;
        if (isDigit(source[k] ?? '')) {
          isFloat = true;
          j = k;
          while (j < n && isDigit(source[j]!)) j += 1;
        }
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i + 1;
      while (j < n && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new GraphQLError(`Unexpected character ${JSON.stringify(c)} in query`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// AST and parser
// ---------------------------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface DirectiveNode {
  readonly name: string;
  readonly args: { name: string; value: ValueNode }[];
}

export interface FieldNode {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: { name: string; value: ValueNode }[];
  readonly directives: DirectiveNode[];
  readonly selectionSet: SelectionNode[] | null;
}

export interface FragmentSpreadNode {
  readonly kind: 'fragmentSpread';
  readonly name: string;
  readonly directives: DirectiveNode[];
}

export interface InlineFragmentNode {
  readonly kind: 'inlineFragment';
  readonly typeCondition: string | null;
  readonly directives: DirectiveNode[];
  readonly selectionSet: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

export type TypeNode =
  | { kind: 'named'; name: string }
  | { kind: 'list'; ofType: TypeNode }
  | { kind: 'nonNull'; ofType: TypeNode };

export interface VariableDefinition {
  readonly name: string;
  readonly type: TypeNode;
  readonly defaultValue: ValueNode | null;
  readonly directives: DirectiveNode[];
}

export interface OperationNode {
  readonly kind: 'operation';
  readonly operation: 'query' | 'mutation' | 'subscription';
  readonly name: string | null;
  readonly variableDefinitions: VariableDefinition[];
  readonly directives: DirectiveNode[];
  readonly selectionSet: SelectionNode[];
}

export interface FragmentNode {
  readonly kind: 'fragment';
  readonly name: string;
  readonly typeCondition: string;
  readonly directives: DirectiveNode[];
  readonly selectionSet: SelectionNode[];
}

export interface DocumentNode {
  readonly operations: OperationNode[];
  readonly fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new GraphQLError(`Expected "${value}" but got ${JSON.stringify(token.value)}`);
    }
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new GraphQLError(`Expected name ${value ?? ''} but got ${JSON.stringify(token.value)}`);
    }
    return token.value;
  }

  private peekName(value: string): boolean {
    const token = this.peek();
    return token.kind === 'name' && token.value === value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      if (this.peek().kind === 'punct' && this.peek().value === '{') {
        operations.push({
          kind: 'operation',
          operation: 'query',
          name: null,
          variableDefinitions: [],
          directives: [],
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        operations.push(this.parseOperation(keyword));
      } else if (keyword === 'fragment') {
        const fragment = this.parseFragment();
        fragments.set(fragment.name, fragment);
      } else {
        throw new GraphQLError(`Unexpected definition keyword ${keyword}`);
      }
    }
    return { operations, fragments };
  }

  private parseOperation(operation: 'query' | 'mutation' | 'subscription'): OperationNode {
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.expectName();
    const variableDefinitions = this.parseVariableDefinitions();
    const directives = this.parseDirectives();
    const selectionSet = this.parseSelectionSet();
    return { kind: 'operation', operation, name, variableDefinitions, directives, selectionSet };
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    const defs: VariableDefinition[] = [];
    if (!this.skipPunct('(')) return defs;
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.skipPunct('=')) defaultValue = this.parseValue();
      const directives = this.parseDirectives();
      defs.push({ name, type, defaultValue, directives });
    }
    return defs;
  }

  private parseType(): TypeNode {
    let type: TypeNode;
    if (this.skipPunct('[')) {
      const inner = this.parseType();
      this.expectPunct(']');
      type = { kind: 'list', ofType: inner };
    } else {
      type = { kind: 'named', name: this.expectName() };
    }
    if (this.skipPunct('!')) type = { kind: 'nonNull', ofType: type };
    return type;
  }

  private parseFragment(): FragmentNode {
    const name = this.expectName();
    if (name === 'on') throw new GraphQLError('Fragment name cannot be "on"');
    this.expectName('on');
    const typeCondition = this.expectName();
    const directives = this.parseDirectives();
    const selectionSet = this.parseSelectionSet();
    return { kind: 'fragment', name, typeCondition, directives, selectionSet };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peekName('on')) {
        this.next();
        const typeCondition = this.expectName();
        const directives = this.parseDirectives();
        const selectionSet = this.parseSelectionSet();
        return { kind: 'inlineFragment', typeCondition, directives, selectionSet };
      }
      if (this.peek().kind === 'name') {
        const name = this.expectName();
        const directives = this.parseDirectives();
        return { kind: 'fragmentSpread', name, directives };
      }
      const directives = this.parseDirectives();
      const selectionSet = this.parseSelectionSet();
      return { kind: 'inlineFragment', typeCondition: null, directives, selectionSet };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.skipPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, directives, selectionSet };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    if (!this.skipPunct('(')) return args;
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.skipPunct('@')) {
      const name = this.expectName();
      const args = this.parseArguments();
      directives.push({ name, args });
    }
    return directives;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        values.push(this.parseValue());
      }
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new GraphQLError(`Unexpected value token ${JSON.stringify(token.value)}`);
  }
}

export function parseGraphQL(source: string): DocumentNode {
  return new Parser(lex(source)).parseDocument();
}

// ---------------------------------------------------------------------------------------------
// value coercion
// ---------------------------------------------------------------------------------------------

type Variables = Record<string, unknown>;

function valueFromAST(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'int':
      return Number.parseInt(node.value, 10);
    case 'float':
      return Number.parseFloat(node.value);
    case 'string':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => valueFromAST(child, variables));
    case 'object': {
      const record: Record<string, unknown> = {};
      for (const field of node.fields) record[field.name] = valueFromAST(field.value, variables);
      return record;
    }
  }
}

function effectiveVariables(operation: OperationNode, provided: Variables): Variables {
  const variables: Variables = { ...provided };
  for (const def of operation.variableDefinitions) {
    if (variables[def.name] === undefined && def.defaultValue !== null) {
      variables[def.name] = valueFromAST(def.defaultValue, variables);
    }
  }
  return variables;
}

// ---------------------------------------------------------------------------------------------
// node builders
// ---------------------------------------------------------------------------------------------

type NodeObject = Record<string, unknown> & { __typename: string };

function userNode(): NodeObject {
  return { __typename: 'User', id: userGlobalId(), databaseId: VIEWER_ID, login: VIEWER_LOGIN, name: 'ada iversen', email: 'adaiversen@example.invalid' };
}

function repoNode(repo: Repo): NodeObject {
  return { __typename: 'Repository', _repo: repo, id: repositoryGlobalId(repo), databaseId: repo.databaseId };
}

function issueNode(repo: Repo, issue: Issue): NodeObject {
  return { __typename: 'Issue', _repo: repo, _issue: issue, id: issueGlobalId(repo, issue), databaseId: issue.id };
}

function pullNode(repo: Repo, pull: PullRequest): NodeObject {
  return { __typename: 'PullRequest', _repo: repo, _pull: pull, id: pullGlobalId(repo, pull), databaseId: pull.id };
}

function commentNode(repo: Repo, comment: { id: number; body: string; createdAt: string }): NodeObject {
  return { __typename: 'IssueComment', _repo: repo, _comment: comment, id: commentGlobalId(repo, comment) };
}

function branchNode(repo: Repo, name: string): NodeObject {
  return { __typename: 'Ref', _repo: repo, name, targetOid: branchTip(repo, name) };
}

function pageInfoNode(hasNextPage: boolean, endCursor: string | null, startCursor: string | null): NodeObject {
  return { __typename: 'PageInfo', hasNextPage, hasPreviousPage: false, endCursor, startCursor };
}

function encodeCursor(seq: number): string {
  return b64urlEncode(`seq:${seq}`);
}

function decodeCursor(cursor: string): number | null {
  const text = b64urlDecode(cursor);
  if (text === null) return null;
  const match = /^seq:(\d+)$/.exec(text);
  return match === null ? null : Number(match[1]);
}

// ---------------------------------------------------------------------------------------------
// introspection schema
// ---------------------------------------------------------------------------------------------

interface SchemaField {
  readonly name: string;
}

interface SchemaType {
  readonly name: string;
  readonly kind: 'OBJECT' | 'ENUM' | 'SCALAR';
  readonly fields: SchemaField[];
  readonly enumValues: string[];
}

const SCHEMA_TYPES: Record<string, SchemaType> = {
  Query: {
    name: 'Query',
    kind: 'OBJECT',
    fields: [{ name: 'viewer' }, { name: 'repository' }, { name: 'node' }],
    enumValues: [],
  },
  Mutation: {
    name: 'Mutation',
    kind: 'OBJECT',
    fields: [
      { name: 'createIssue' },
      { name: 'closeIssue' },
      { name: 'createPullRequest' },
      { name: 'mergePullRequest' },
      { name: 'addComment' },
    ],
    enumValues: [],
  },
  User: {
    name: 'User',
    kind: 'OBJECT',
    fields: [{ name: 'id' }, { name: 'databaseId' }, { name: 'login' }, { name: 'name' }, { name: 'email' }],
    enumValues: [],
  },
  Repository: {
    name: 'Repository',
    kind: 'OBJECT',
    fields: [
      { name: 'id' },
      { name: 'databaseId' },
      { name: 'name' },
      { name: 'nameWithOwner' },
      { name: 'owner' },
      { name: 'defaultBranchRef' },
      { name: 'viewerPermission' },
      { name: 'hasIssuesEnabled' },
      { name: 'issue' },
      { name: 'issues' },
      { name: 'pullRequests' },
      { name: 'pullRequest' },
      { name: 'createdAt' },
      { name: 'url' },
    ],
    enumValues: [],
  },
  Ref: {
    name: 'Ref',
    kind: 'OBJECT',
    fields: [{ name: 'name' }, { name: 'target' }],
    enumValues: [],
  },
  Commit: {
    name: 'Commit',
    kind: 'OBJECT',
    fields: [{ name: 'oid' }, { name: 'message' }],
    enumValues: [],
  },
  Issue: {
    name: 'Issue',
    kind: 'OBJECT',
    fields: [
      { name: 'id' },
      { name: 'number' },
      { name: 'title' },
      { name: 'state' },
      { name: 'body' },
      { name: 'createdAt' },
      { name: 'author' },
      { name: 'repository' },
      { name: 'comments' },
      { name: 'labels' },
      { name: 'url' },
    ],
    enumValues: [],
  },
  IssueConnection: {
    name: 'IssueConnection',
    kind: 'OBJECT',
    fields: [{ name: 'nodes' }, { name: 'pageInfo' }, { name: 'totalCount' }],
    enumValues: [],
  },
  IssueComment: {
    name: 'IssueComment',
    kind: 'OBJECT',
    fields: [{ name: 'id' }, { name: 'body' }, { name: 'author' }, { name: 'createdAt' }],
    enumValues: [],
  },
  IssueCommentConnection: {
    name: 'IssueCommentConnection',
    kind: 'OBJECT',
    fields: [{ name: 'nodes' }, { name: 'pageInfo' }, { name: 'totalCount' }],
    enumValues: [],
  },
  IssueCommentEdge: {
    name: 'IssueCommentEdge',
    kind: 'OBJECT',
    fields: [{ name: 'node' }],
    enumValues: [],
  },
  Label: {
    name: 'Label',
    kind: 'OBJECT',
    fields: [{ name: 'name' }, { name: 'color' }],
    enumValues: [],
  },
  LabelConnection: {
    name: 'LabelConnection',
    kind: 'OBJECT',
    fields: [{ name: 'nodes' }, { name: 'pageInfo' }, { name: 'totalCount' }],
    enumValues: [],
  },
  PullRequest: {
    name: 'PullRequest',
    kind: 'OBJECT',
    fields: [
      { name: 'id' },
      { name: 'number' },
      { name: 'title' },
      { name: 'state' },
      { name: 'body' },
      { name: 'headRefName' },
      { name: 'baseRefName' },
      { name: 'mergeable' },
      { name: 'merged' },
      { name: 'files' },
      { name: 'createdAt' },
      { name: 'author' },
      { name: 'repository' },
      { name: 'mergedAt' },
      { name: 'mergeCommitSha' },
      { name: 'url' },
    ],
    enumValues: [],
  },
  PullRequestConnection: {
    name: 'PullRequestConnection',
    kind: 'OBJECT',
    fields: [{ name: 'nodes' }, { name: 'pageInfo' }, { name: 'totalCount' }],
    enumValues: [],
  },
  PullRequestFile: {
    name: 'PullRequestFile',
    kind: 'OBJECT',
    fields: [{ name: 'path' }, { name: 'filename' }],
    enumValues: [],
  },
  PullRequestFileConnection: {
    name: 'PullRequestFileConnection',
    kind: 'OBJECT',
    fields: [{ name: 'nodes' }, { name: 'pageInfo' }, { name: 'totalCount' }],
    enumValues: [],
  },
  PageInfo: {
    name: 'PageInfo',
    kind: 'OBJECT',
    fields: [{ name: 'hasNextPage' }, { name: 'hasPreviousPage' }, { name: 'endCursor' }, { name: 'startCursor' }],
    enumValues: [],
  },
  SearchType: {
    name: 'SearchType',
    kind: 'ENUM',
    fields: [],
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  },
  CreateIssuePayload: {
    name: 'CreateIssuePayload',
    kind: 'OBJECT',
    fields: [{ name: 'issue' }],
    enumValues: [],
  },
  CloseIssuePayload: {
    name: 'CloseIssuePayload',
    kind: 'OBJECT',
    fields: [{ name: 'issue' }],
    enumValues: [],
  },
  CreatePullRequestPayload: {
    name: 'CreatePullRequestPayload',
    kind: 'OBJECT',
    fields: [{ name: 'pullRequest' }],
    enumValues: [],
  },
  MergePullRequestPayload: {
    name: 'MergePullRequestPayload',
    kind: 'OBJECT',
    fields: [{ name: 'pullRequest' }],
    enumValues: [],
  },
  AddCommentPayload: {
    name: 'AddCommentPayload',
    kind: 'OBJECT',
    fields: [{ name: 'commentEdge' }],
    enumValues: [],
  },
};

function introspectionTypeNode(schema: SchemaType): NodeObject {
  return {
    __typename: '__Type',
    name: schema.name,
    kind: schema.kind,
    _fields: schema.fields.map((field) => ({
      __typename: '__Field',
      name: field.name,
      description: '',
      isDeprecated: false,
    })),
    _enumValues: schema.enumValues.map((name) => ({
      __typename: '__EnumValue',
      name,
      description: '',
      isDeprecated: false,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// connections
// ---------------------------------------------------------------------------------------------

interface ConnectionArgs {
  first: number | null;
  after: string | null;
  states: string[] | null;
  direction: 'ASC' | 'DESC';
}

function connectionArgs(args: Record<string, unknown>): ConnectionArgs {
  const first = typeof args.first === 'number' ? args.first : null;
  const after = typeof args.after === 'string' ? args.after : null;
  let states: string[] | null = null;
  if (Array.isArray(args.states)) states = args.states.filter((s): s is string => typeof s === 'string');
  else if (typeof args.states === 'string') states = [args.states];
  let direction: 'ASC' | 'DESC' = 'DESC';
  if (isRecord(args.orderBy) && args.orderBy.direction === 'ASC') direction = 'ASC';
  return { first, after, states, direction };
}

function issueConnection(repo: Repo, args: Record<string, unknown>): NodeObject {
  const { first, after, states, direction } = connectionArgs(args);
  let issues = [...repo.issues.values()];
  if (states !== null) {
    const wanted = new Set(states.map((s) => s.toUpperCase()));
    issues = issues.filter((issue) => wanted.has(issue.state.toUpperCase()));
  }
  issues.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
  if (after !== null) {
    const cursorSeq = decodeCursor(after);
    if (cursorSeq !== null) {
      issues = issues.filter((issue) => (direction === 'ASC' ? issue.seq > cursorSeq : issue.seq < cursorSeq));
    }
  }
  const totalCount = issues.length;
  const page = first === null ? issues : issues.slice(0, Math.max(0, first));
  const hasNextPage = first !== null && issues.length > page.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.seq) : null;
  const startCursor = page.length > 0 ? encodeCursor(page[0]!.seq) : null;
  return {
    __typename: 'IssueConnection',
    _nodes: page.map((issue) => issueNode(repo, issue)),
    _pageInfo: pageInfoNode(hasNextPage, endCursor, startCursor),
    totalCount,
  };
}

function pullConnection(repo: Repo, args: Record<string, unknown>): NodeObject {
  const first = typeof args.first === 'number' ? args.first : null;
  const after = typeof args.after === 'string' ? args.after : null;
  let pulls = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq);
  if (after !== null) {
    const cursorSeq = decodeCursor(after);
    if (cursorSeq !== null) pulls = pulls.filter((pull) => pull.seq < cursorSeq);
  }
  const totalCount = pulls.length;
  const page = first === null ? pulls : pulls.slice(0, Math.max(0, first));
  const hasNextPage = first !== null && pulls.length > page.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.seq) : null;
  const startCursor = page.length > 0 ? encodeCursor(page[0]!.seq) : null;
  return {
    __typename: 'PullRequestConnection',
    _nodes: page.map((pull) => pullNode(repo, pull)),
    _pageInfo: pageInfoNode(hasNextPage, endCursor, startCursor),
    totalCount,
  };
}

function fileConnection(repo: Repo, pull: PullRequest, args: Record<string, unknown>): NodeObject {
  const first = typeof args.first === 'number' ? args.first : null;
  const changes = pullFiles(repo, pull);
  const page = first === null ? changes : changes.slice(0, Math.max(0, first));
  const hasNextPage = first !== null && changes.length > page.length;
  return {
    __typename: 'PullRequestFileConnection',
    _nodes: page.map((change) => ({ __typename: 'PullRequestFile', path: change.path, filename: change.path })),
    _pageInfo: pageInfoNode(hasNextPage, null, null),
    totalCount: changes.length,
  };
}

// ---------------------------------------------------------------------------------------------
// resolvers
// ---------------------------------------------------------------------------------------------

interface Context {
  readonly store: Store;
}

type Resolver = (parent: NodeObject, args: Record<string, unknown>, ctx: Context) => unknown;

function repoOf(parent: NodeObject): Repo {
  return parent._repo as Repo;
}

function issueOf(parent: NodeObject): Issue {
  return parent._issue as Issue;
}

function pullOf(parent: NodeObject): PullRequest {
  return parent._pull as PullRequest;
}

function pullState(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state.toUpperCase();
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userNode(),
    repository: (_parent, args, ctx) => {
      const owner = args.owner;
      const name = args.name;
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo === undefined ? null : repoNode(repo);
    },
    node: (_parent, args, ctx) => {
      const id = args.id;
      if (typeof id !== 'string') return null;
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.kind === 'User') return userNode();
      const repo = repoByDatabaseId(ctx.store, decoded.databaseId);
      if (repo === undefined) return null;
      if (decoded.kind === 'Repository') return repoNode(repo);
      if (decoded.kind === 'Issue') {
        const issue = repo.issues.get(decoded.number);
        return issue === undefined ? null : issueNode(repo, issue);
      }
      if (decoded.kind === 'PullRequest') {
        const pull = repo.pulls.get(decoded.number);
        return pull === undefined ? null : pullNode(repo, pull);
      }
      return null;
    },
    __type: (_parent, args) => {
      const name = args.name;
      if (typeof name !== 'string') return null;
      const schema = SCHEMA_TYPES[name];
      return schema === undefined ? null : introspectionTypeNode(schema);
    },
    __schema: () => ({ __typename: '__Schema', queryType: { __typename: '__Type', name: 'Query' }, mutationType: { __typename: '__Type', name: 'Mutation' } }),
  },
  Mutation: {
    createIssue: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const repo = repoFromGlobalId(ctx.store, input.repositoryId);
      if (repo === null) throw new GraphQLError('repositoryId does not name a repository');
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') throw new GraphQLError('title is required');
      const issue = ctx.store.createIssue(repo, {
        title,
        body: typeof input.body === 'string' ? input.body : '',
        labels: [],
      });
      return { __typename: 'CreateIssuePayload', _issue: issueNode(repo, issue) };
    },
    closeIssue: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const found = subjectFromGlobalId(ctx.store, input.issueId);
      if (found === null || found.issue === undefined) throw new GraphQLError('issueId does not name an issue');
      found.issue.state = 'closed';
      found.issue.updatedAt = forgeTimestamp();
      return { __typename: 'CloseIssuePayload', _issue: issueNode(found.repo, found.issue) };
    },
    createPullRequest: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const repo = repoFromGlobalId(ctx.store, input.repositoryId);
      if (repo === null) throw new GraphQLError('repositoryId does not name a repository');
      const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
      const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const title = typeof input.title === 'string' ? input.title : '';
      const headTip = branchTip(repo, headRef);
      const baseTip = branchTip(repo, baseRef);
      if (headTip === null || baseTip === null) throw new GraphQLError('head and base must name existing branches');
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
          throw new GraphQLError('a pull request already exists for this head and base');
        }
      }
      const pull = ctx.store.createPull(repo, {
        title,
        body: typeof input.body === 'string' ? input.body : '',
        headRef,
        baseRef,
        headSha: headTip,
        baseSha: baseTip,
      });
      return { __typename: 'CreatePullRequestPayload', _pull: pullNode(repo, pull) };
    },
    mergePullRequest: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const found = subjectFromGlobalId(ctx.store, input.pullRequestId);
      if (found === null || found.pull === undefined) throw new GraphQLError('pullRequestId does not name a pull request');
      try {
        squashMerge(found.repo, found.pull);
      } catch (err) {
        if (err instanceof ForgeError) throw new GraphQLError(err.message);
        throw err;
      }
      found.pull.updatedAt = forgeTimestamp();
      return { __typename: 'MergePullRequestPayload', _pull: pullNode(found.repo, found.pull) };
    },
    addComment: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const found = subjectFromGlobalId(ctx.store, input.subjectId);
      if (found === null) throw new GraphQLError('subjectId does not name an issue or pull request');
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = ctx.store.addComment(found.repo, found.number, body);
      const edge: NodeObject = {
        __typename: 'IssueCommentEdge',
        _comment: commentNode(found.repo, comment),
      };
      return { __typename: 'AddCommentPayload', _edge: edge };
    },
  },
  User: {
    id: (parent) => parent.id,
    databaseId: (parent) => parent.databaseId,
    login: (parent) => parent.login,
    name: (parent) => parent.name,
    email: (parent) => parent.email,
  },
  Repository: {
    id: (parent) => parent.id,
    databaseId: (parent) => parent.databaseId,
    name: (parent) => repoOf(parent).name,
    nameWithOwner: (parent) => `${repoOf(parent).owner}/${repoOf(parent).name}`,
    owner: () => userNode(),
    defaultBranchRef: (parent) => {
      const repo = repoOf(parent);
      return branchTip(repo, repo.defaultBranch) === null ? null : branchNode(repo, repo.defaultBranch);
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (parent, args) => {
      const repo = repoOf(parent);
      const number = typeof args.number === 'number' ? args.number : null;
      if (number === null) return null;
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueNode(repo, issue);
    },
    issues: (parent, args) => issueConnection(repoOf(parent), args),
    pullRequests: (parent, args) => pullConnection(repoOf(parent), args),
    pullRequest: (parent, args) => {
      const repo = repoOf(parent);
      const number = typeof args.number === 'number' ? args.number : null;
      if (number === null) return null;
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : pullNode(repo, pull);
    },
    createdAt: (parent) => repoOf(parent).createdAt,
    url: (parent) => `/${repoOf(parent).owner}/${repoOf(parent).name}`,
  },
  Ref: {
    name: (parent) => parent.name,
    target: (parent) => {
      const repo = repoOf(parent);
      const oid = branchTip(repo, parent.name as string);
      if (oid === null) return null;
      const object = repo.objects.get(oid);
      if (object === undefined) return null;
      return { __typename: 'Commit', oid, message: '' };
    },
  },
  Commit: {
    oid: (parent) => parent.oid,
    message: (parent) => parent.message,
  },
  Issue: {
    id: (parent) => parent.id,
    number: (parent) => issueOf(parent).number,
    title: (parent) => issueOf(parent).title,
    state: (parent) => issueOf(parent).state.toUpperCase(),
    body: (parent) => issueOf(parent).body,
    createdAt: (parent) => issueOf(parent).createdAt,
    author: () => userNode(),
    repository: (parent) => repoNode(repoOf(parent)),
    comments: (parent) => {
      const repo = repoOf(parent);
      const issue = issueOf(parent);
      const comments = repo.comments.get(issue.number) ?? [];
      return {
        __typename: 'IssueCommentConnection',
        _nodes: comments.map((comment) => commentNode(repo, comment)),
        _pageInfo: pageInfoNode(false, null, null),
        totalCount: comments.length,
      };
    },
    labels: (parent) => {
      const repo = repoOf(parent);
      const issue = issueOf(parent);
      return {
        __typename: 'LabelConnection',
        _nodes: issue.labels.map((name) => ({ __typename: 'Label', name, color: repo.labels.get(name)?.color ?? 'ededed' })),
        _pageInfo: pageInfoNode(false, null, null),
        totalCount: issue.labels.length,
      };
    },
    url: (parent) => `/${repoOf(parent).owner}/${repoOf(parent).name}/issues/${issueOf(parent).number}`,
  },
  IssueConnection: {
    nodes: (parent) => parent._nodes,
    pageInfo: (parent) => parent._pageInfo,
    totalCount: (parent) => parent.totalCount,
  },
  IssueComment: {
    id: (parent) => parent.id,
    body: (parent) => (parent._comment as { body: string }).body,
    author: () => userNode(),
    createdAt: (parent) => (parent._comment as { createdAt: string }).createdAt,
  },
  IssueCommentConnection: {
    nodes: (parent) => parent._nodes,
    pageInfo: (parent) => parent._pageInfo,
    totalCount: (parent) => parent.totalCount,
  },
  IssueCommentEdge: {
    node: (parent) => parent._comment,
  },
  Label: {
    name: (parent) => parent.name,
    color: (parent) => parent.color,
  },
  LabelConnection: {
    nodes: (parent) => parent._nodes,
    pageInfo: (parent) => parent._pageInfo,
    totalCount: (parent) => parent.totalCount,
  },
  PullRequest: {
    id: (parent) => parent.id,
    number: (parent) => pullOf(parent).number,
    title: (parent) => pullOf(parent).title,
    state: (parent) => pullState(pullOf(parent)),
    body: (parent) => pullOf(parent).body,
    headRefName: (parent) => pullOf(parent).headRef,
    baseRefName: (parent) => pullOf(parent).baseRef,
    mergeable: (parent) => pullMergeable(repoOf(parent), pullOf(parent)),
    merged: (parent) => pullOf(parent).merged,
    files: (parent, args) => fileConnection(repoOf(parent), pullOf(parent), args),
    createdAt: (parent) => pullOf(parent).createdAt,
    author: () => userNode(),
    repository: (parent) => repoNode(repoOf(parent)),
    mergedAt: (parent) => pullOf(parent).mergedAt,
    mergeCommitSha: (parent) => pullOf(parent).mergeCommitSha,
    url: (parent) => `/${repoOf(parent).owner}/${repoOf(parent).name}/pull/${pullOf(parent).number}`,
  },
  PullRequestConnection: {
    nodes: (parent) => parent._nodes,
    pageInfo: (parent) => parent._pageInfo,
    totalCount: (parent) => parent.totalCount,
  },
  PullRequestFile: {
    path: (parent) => parent.path,
    filename: (parent) => parent.filename,
  },
  PullRequestFileConnection: {
    nodes: (parent) => parent._nodes,
    pageInfo: (parent) => parent._pageInfo,
    totalCount: (parent) => parent.totalCount,
  },
  PageInfo: {
    hasNextPage: (parent) => parent.hasNextPage,
    hasPreviousPage: (parent) => parent.hasPreviousPage,
    endCursor: (parent) => parent.endCursor,
    startCursor: (parent) => parent.startCursor,
  },
  CreateIssuePayload: {
    issue: (parent) => parent._issue,
  },
  CloseIssuePayload: {
    issue: (parent) => parent._issue,
  },
  CreatePullRequestPayload: {
    pullRequest: (parent) => parent._pull,
  },
  MergePullRequestPayload: {
    pullRequest: (parent) => parent._pull,
  },
  AddCommentPayload: {
    commentEdge: (parent) => parent._edge,
  },
  __Type: {
    name: (parent) => parent.name,
    kind: (parent) => parent.kind,
    fields: (parent) => (parent.kind === 'OBJECT' ? parent._fields : null),
    enumValues: (parent) => (parent.kind === 'ENUM' ? parent._enumValues : null),
  },
  __Field: {
    name: (parent) => parent.name,
    description: (parent) => parent.description,
    isDeprecated: (parent) => parent.isDeprecated,
    args: () => [],
  },
  __EnumValue: {
    name: (parent) => parent.name,
    description: (parent) => parent.description,
    isDeprecated: (parent) => parent.isDeprecated,
  },
  __Schema: {
    queryType: (parent) => parent.queryType,
    mutationType: (parent) => parent.mutationType,
  },
};

function repoFromGlobalId(store: Store, value: unknown): Repo | null {
  if (typeof value !== 'string') return null;
  const decoded = decodeGlobalId(value);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  return repoByDatabaseId(store, decoded.databaseId) ?? null;
}

function subjectFromGlobalId(
  store: Store,
  value: unknown,
): { repo: Repo; number: number; issue?: Issue; pull?: PullRequest } | null {
  if (typeof value !== 'string') return null;
  const decoded = decodeGlobalId(value);
  if (decoded === null) return null;
  if (decoded.kind !== 'Issue' && decoded.kind !== 'PullRequest') return null;
  const repo = repoByDatabaseId(store, decoded.databaseId);
  if (repo === undefined) return null;
  if (decoded.kind === 'Issue') {
    const issue = repo.issues.get(decoded.number);
    return issue === undefined ? null : { repo, number: decoded.number, issue };
  }
  const pull = repo.pulls.get(decoded.number);
  return pull === undefined ? null : { repo, number: decoded.number, pull };
}

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

interface ExecutionContext {
  readonly store: Store;
  readonly variables: Variables;
  readonly fragments: Map<string, FragmentNode>;
}

function directivesAllow(directives: DirectiveNode[], variables: Variables): boolean {
  for (const directive of directives) {
    if (directive.name !== 'skip' && directive.name !== 'include') continue;
    const ifArg = directive.args.find((arg) => arg.name === 'if');
    if (ifArg === undefined) continue;
    const value = valueFromAST(ifArg.value, variables);
    if (directive.name === 'skip' && value === true) return false;
    if (directive.name === 'include' && value !== true) return false;
  }
  return true;
}

function executeSelectionSet(
  object: NodeObject,
  selections: SelectionNode[],
  ctx: ExecutionContext,
  visitedFragments: Set<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (!directivesAllow(selection.directives, ctx.variables)) continue;
      const key = selection.alias ?? selection.name;
      result[key] = executeField(object, selection, ctx);
    } else if (selection.kind === 'inlineFragment') {
      if (!directivesAllow(selection.directives, ctx.variables)) continue;
      if (selection.typeCondition !== null && selection.typeCondition !== object.__typename) continue;
      Object.assign(result, executeSelectionSet(object, selection.selectionSet, ctx, visitedFragments));
    } else {
      if (!directivesAllow(selection.directives, ctx.variables)) continue;
      if (visitedFragments.has(selection.name)) continue;
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) throw new GraphQLError(`Unknown fragment "${selection.name}"`);
      if (fragment.typeCondition !== object.__typename) continue;
      visitedFragments.add(selection.name);
      Object.assign(result, executeSelectionSet(object, fragment.selectionSet, ctx, visitedFragments));
    }
  }
  return result;
}

function executeField(object: NodeObject, field: FieldNode, ctx: ExecutionContext): unknown {
  const typename = object.__typename;
  if (field.name === '__typename') return typename;
  const table = RESOLVERS[typename];
  const resolver = table?.[field.name];
  if (resolver === undefined) {
    throw new GraphQLError(`Cannot query field "${field.name}" on type "${typename}"`);
  }
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = valueFromAST(arg.value, ctx.variables);
  const value = resolver(object, args, { store: ctx.store });
  if (field.selectionSet === null) {
    if (value !== null && typeof value === 'object') {
      throw new GraphQLError(`Field "${field.name}" of type "${typename}" must have a selection of subfields`);
    }
    return value;
  }
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item !== null && typeof item === 'object' && '__typename' in item) {
        return executeSelectionSet(item as NodeObject, field.selectionSet!, ctx, new Set());
      }
      return item;
    });
  }
  if (typeof value === 'object' && '__typename' in value) {
    return executeSelectionSet(value as NodeObject, field.selectionSet, ctx, new Set());
  }
  throw new GraphQLError(`Field "${field.name}" of type "${typename}" must not have a selection of subfields`);
}

function executeOperation(store: Store, doc: DocumentNode, operationName: string | null, variables: Variables): Record<string, unknown> {
  let operation: OperationNode | undefined;
  if (operationName !== null) {
    operation = doc.operations.find((op) => op.name === operationName);
    if (operation === undefined) throw new GraphQLError(`Unknown operation named "${operationName}"`);
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0]!;
  } else if (doc.operations.length === 0) {
    throw new GraphQLError('Document contains no operations');
  } else {
    throw new GraphQLError('Must provide operation name when the document contains multiple operations');
  }
  if (operation.operation === 'subscription') throw new GraphQLError('Subscriptions are not supported');
  const effective = effectiveVariables(operation, variables);
  const root: NodeObject = { __typename: operation.operation === 'mutation' ? 'Mutation' : 'Query' };
  const ctx: ExecutionContext = { store, variables: effective, fragments: doc.fragments };
  const data = executeSelectionSet(root, operation.selectionSet, ctx, new Set());
  return { data };
}

export interface GraphQLResponse {
  readonly data?: unknown;
  readonly errors?: { message: string }[];
}

function executeOne(store: Store, body: unknown): GraphQLResponse {
  if (!isRecord(body)) {
    return { data: null, errors: [{ message: 'GraphQL request body must be an object' }] };
  }
  const query = body.query;
  if (typeof query !== 'string') {
    return { data: null, errors: [{ message: 'query must be a string' }] };
  }
  const variables = isRecord(body.variables) ? (body.variables as Variables) : {};
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  try {
    const doc = parseGraphQL(query);
    return executeOperation(store, doc, operationName, variables);
  } catch (err) {
    if (err instanceof GraphQLError) return { data: null, errors: [{ message: err.message }] };
    throw err;
  }
}

/**
 * Handle a GraphQL request body: a single operation object, or a batch array of
 * operation objects answered in order.
 */
export function handleGraphQL(store: Store, body: unknown): GraphQLResponse | GraphQLResponse[] {
  if (Array.isArray(body)) {
    return body.map((entry) => executeOne(store, entry));
  }
  return executeOne(store, body);
}
