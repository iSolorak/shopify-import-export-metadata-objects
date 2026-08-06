// Admin API access for the metaobject import/export feature.
//
// Every operation here was validated against the 2026-07 Admin schema, which is
// the version `app/shopify.server.ts` pins. Note `metaobjectUpsert` takes a
// `metaobject: MetaobjectUpsertInput!` argument on this version — the shorter
// `values: JSON` form exists only on newer versions and will not compile here.

/**
 * The shape we need from the object `authenticate.admin()` returns. Declared
 * structurally so this module does not depend on the library's exported type
 * names, which move between major versions.
 */
type Admin = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export type FieldDefinition = {
  key: string;
  name: string;
  description: string | null;
  required: boolean;
  type: string;
  validations: { name: string; value: string | null }[];
};

export type Definition = {
  id: string;
  type: string;
  name: string;
  description: string | null;
  displayNameKey: string | null;
  fieldDefinitions: FieldDefinition[];
};

export type Entry = {
  id: string;
  handle: string;
  displayName: string | null;
  values: Record<string, string>;
};

// Shopify caps `first` at 250 for these connections. Paging at the maximum
// keeps a large export to as few round trips as the rate limit allows.
const PAGE_SIZE = 250;

type PageInfo = { hasNextPage: boolean; endCursor: string | null };

/** The `userErrors` shape shared by both metaobject mutations. */
type UserError = { field: string[] | null; message: string; code: string | null };

/** Run an operation and surface transport and GraphQL errors as exceptions. */
async function query<T>(
  admin: Admin,
  document: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await admin.graphql(document, { variables });
  const body = (await response.json()) as {
    data?: T;
    errors?: { message: string }[];
  };

  // A GraphQL API can return HTTP 200 with a populated `errors` array, so the
  // status alone is not enough to conclude the call succeeded.
  if (!response.ok || body.errors) {
    const detail = body.errors?.map((error) => error.message).join("; ");
    throw new Error(detail || `Admin API request failed (${response.status})`);
  }

  return body.data as T;
}

/** Turn mutation user errors into one readable line each. */
function formatUserErrors(userErrors: UserError[]): string[] {
  return userErrors.map((error) =>
    error.field?.length
      ? `${error.field.join(".")}: ${error.message}`
      : error.message,
  );
}

const DEFINITIONS_LIST = `#graphql
  query MetaobjectDefinitionsList($cursor: String) {
    metaobjectDefinitions(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        type
        displayNameKey
        metaobjectsCount
        fieldDefinitions { key name required type { name } }
      }
    }
  }
`;

export type DefinitionSummary = {
  id: string;
  type: string;
  name: string;
  entryCount: number;
  fieldKeys: string[];
};

type DefinitionsListResponse = {
  metaobjectDefinitions: {
    pageInfo: PageInfo;
    nodes: {
      id: string;
      name: string;
      type: string;
      displayNameKey: string | null;
      metaobjectsCount: number;
      fieldDefinitions: { key: string }[];
    }[];
  };
};

export async function listDefinitions(
  admin: Admin,
): Promise<DefinitionSummary[]> {
  const summaries: DefinitionSummary[] = [];
  let cursor: string | null = null;

  do {
    // Annotated because `cursor` is both an input here and assigned from the
    // result below; without it TypeScript cannot break that inference cycle.
    const data: DefinitionsListResponse = await query<DefinitionsListResponse>(
      admin,
      DEFINITIONS_LIST,
      { cursor },
    );
    const connection = data.metaobjectDefinitions;

    for (const node of connection.nodes) {
      summaries.push({
        id: node.id,
        type: node.type,
        name: node.name,
        entryCount: node.metaobjectsCount,
        fieldKeys: node.fieldDefinitions.map((field) => field.key),
      });
    }

    cursor = connection.pageInfo.hasNextPage
      ? connection.pageInfo.endCursor
      : null;
  } while (cursor);

  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

const DEFINITION_BY_TYPE = `#graphql
  query MetaobjectDefinitionByType($type: String!) {
    metaobjectDefinitionByType(type: $type) {
      id
      name
      type
      description
      displayNameKey
      fieldDefinitions {
        key
        name
        description
        required
        type { name }
        validations { name value }
      }
    }
  }
`;

type DefinitionByTypeResponse = {
  metaobjectDefinitionByType: {
    id: string;
    name: string;
    type: string;
    description: string | null;
    displayNameKey: string | null;
    fieldDefinitions: {
      key: string;
      name: string;
      description: string | null;
      required: boolean;
      type: { name: string };
      validations: { name: string; value: string | null }[];
    }[];
  } | null;
};

export async function getDefinition(
  admin: Admin,
  type: string,
): Promise<Definition | null> {
  const data = await query<DefinitionByTypeResponse>(admin, DEFINITION_BY_TYPE, {
    type,
  });
  const node = data.metaobjectDefinitionByType;
  if (!node) return null;

  return {
    id: node.id,
    type: node.type,
    name: node.name,
    description: node.description,
    displayNameKey: node.displayNameKey,
    fieldDefinitions: node.fieldDefinitions.map((field) => ({
      key: field.key,
      name: field.name,
      description: field.description,
      required: field.required,
      type: field.type.name,
      validations: field.validations,
    })),
  };
}

const ENTRIES_PAGE = `#graphql
  query MetaobjectEntriesPage($type: String!, $cursor: String, $pageSize: Int!) {
    metaobjects(type: $type, first: $pageSize, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        displayName
        fields { key value }
      }
    }
  }
`;

/**
 * Fetch every entry of a type.
 *
 * `field.value` is the API's own string encoding — JSON for list and reference
 * fields, a plain string otherwise. Exporting it verbatim is what makes the
 * round trip lossless, so it is deliberately not parsed or reformatted here.
 */
type EntriesPageResponse = {
  metaobjects: {
    pageInfo: PageInfo;
    nodes: {
      id: string;
      handle: string;
      displayName: string | null;
      fields: { key: string; value: string | null }[];
    }[];
  };
};

export async function getEntries(admin: Admin, type: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  let cursor: string | null = null;

  do {
    // Annotated for the same inference-cycle reason as listDefinitions.
    const data: EntriesPageResponse = await query<EntriesPageResponse>(
      admin,
      ENTRIES_PAGE,
      { type, cursor, pageSize: PAGE_SIZE },
    );
    const connection = data.metaobjects;

    for (const node of connection.nodes) {
      const values: Record<string, string> = {};
      for (const field of node.fields) {
        values[field.key] = field.value ?? "";
      }
      entries.push({
        id: node.id,
        handle: node.handle,
        displayName: node.displayName,
        values,
      });
    }

    cursor = connection.pageInfo.hasNextPage
      ? connection.pageInfo.endCursor
      : null;
  } while (cursor);

  return entries;
}

const UPSERT_ENTRY = `#graphql
  mutation MetaobjectUpsertEntry(
    $handle: MetaobjectHandleInput!
    $metaobject: MetaobjectUpsertInput!
  ) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
      metaobject { id handle type }
      userErrors { field message code }
    }
  }
`;

/**
 * Create or update one entry, keyed by handle.
 *
 * Returns the user errors rather than throwing them: one bad row in a long
 * import should be reported alongside the rows that succeeded, not abort the
 * whole run and leave the merchant guessing how far it got.
 */
export async function upsertEntry(
  admin: Admin,
  type: string,
  handle: string,
  values: Record<string, string>,
): Promise<{ ok: boolean; errors: string[] }> {
  const data = await query<{
    metaobjectUpsert: { userErrors: UserError[] };
  }>(admin, UPSERT_ENTRY, {
    handle: { type, handle },
    metaobject: {
      fields: Object.entries(values).map(([key, value]) => ({ key, value })),
    },
  });

  const { userErrors } = data.metaobjectUpsert;

  return {
    ok: userErrors.length === 0,
    errors: formatUserErrors(userErrors),
  };
}

const DEFINITION_CREATE = `#graphql
  mutation MetaobjectDefinitionCreateFromCsv(
    $definition: MetaobjectDefinitionCreateInput!
  ) {
    metaobjectDefinitionCreate(definition: $definition) {
      metaobjectDefinition { id type name }
      userErrors { field message code }
    }
  }
`;

export async function createDefinition(
  admin: Admin,
  definition: {
    type: string;
    name: string;
    description?: string | null;
    displayNameKey?: string | null;
    fieldDefinitions: {
      key: string;
      name: string;
      description?: string | null;
      required: boolean;
      type: string;
      validations: { name: string; value: string | null }[];
    }[];
  },
): Promise<{ ok: boolean; errors: string[] }> {
  const data = await query<{
    metaobjectDefinitionCreate: { userErrors: UserError[] };
  }>(admin, DEFINITION_CREATE, {
    definition: {
      type: definition.type,
      name: definition.name,
      ...(definition.description ? { description: definition.description } : {}),
      ...(definition.displayNameKey
        ? { displayNameKey: definition.displayNameKey }
        : {}),
      fieldDefinitions: definition.fieldDefinitions.map((field) => ({
        key: field.key,
        name: field.name,
        ...(field.description ? { description: field.description } : {}),
        required: field.required,
        type: field.type,
        // The API rejects a null `value`, so drop incomplete validations
        // rather than passing them through and failing the whole definition.
        validations: field.validations
          .filter((v) => v.value !== null)
          .map((v) => ({ name: v.name, value: v.value as string })),
      })),
    },
  });

  const { userErrors } = data.metaobjectDefinitionCreate;

  return {
    ok: userErrors.length === 0,
    errors: formatUserErrors(userErrors),
  };
}
