
// concatened string in consequent should be visually distinguishable from alternate
const avatar = has_ordered
  ? 'https://marmelab.com/posters/avatar-' +
    numberOfCustomers +
    '.jpeg'
  : undefined;

// Similarly, in the alternate:
const redirectUrl = pathName
  ? pathName
  : nextPathName + nextSearch ||
    defaultAuthParams.afterLoginUrl;

// And another, more pathological case of the above:
const isEmpty = obj =>
  obj instanceof Date
    ? false
    : obj === '' ||
      obj === null ||
      obj === undefined ||
      shallowEqual(obj, {});

// Ternaries in JSXExpressionContainers that are just attributes
// should not use jsxMode
const component = (
  <List
    dense={dense}
    component="div"
    disablePadding
    className={
      sidebarIsOpen ?
        classes.sidebarIsOpen :
        classes.sidebarIsClosed
    }
  >
    {children}
  </List>
);

// Template strings with multiple entries, back-to-back with spaces,
// should not make it hard to distinguish the alternate.
const field = (
  <FunctionField
    render={(record = Record) =>
        record
          ? `${
                (record_as_Customer)
                    .first_name
            } ${
                (record_as_Customer)
                    .last_name
            }`
          : ''
    }
    variant="subtitle1"
    className={classes.inline}
  />
);

// Again, this case is a bit hard to distinguish the alternate.
const eventsFromOrders =
  orderIds && orders
    ? orderIds.map(id => ({
          type: 'order',
          date: orders[id].date,
          data: orders[id],
      }))
    : [];

// Kinda weird to have dedents to the level of "return" in a function.
function foo() {
  return !linkTo
    ? false
    : typeof linkTo === 'function'
      ? linkTo(record, reference)
      : linkToRecord(rootPath, sourceId, linkTo_as_string);
}
function foo2() {
  return React.isValidElement(emptyText)
    ? React.cloneElement(emptyText)
    : emptyText === ''
      ? ' ' // em space, forces the display of an empty line of normal height
      : translate(emptyText, { _: emptyText });
}

// Function call ideally wouldnt break break
const matchingReferencesError = isMatchingReferencesError(
  matchingReferences
)
  ? translate(matchingReferences.error, {
      _: matchingReferences.error,
    })
  : null;

// This one is kinda confusing any way you slice it…
const obj = {
  error:
    matchingReferencesError &&
    (!input.value ||
      (input.value &&
        selectedReferencesDataStatus === REFERENCES_STATUS_EMPTY))
      ? translate('ra.input.references.all_missing', {
          _: 'ra.input.references.all_missing',
        })
      : null,
}

// I think we should indent after the inner || on this, and do better wtih the parens around the &&
const obj2 = {
  warning:
    matchingReferencesError ||
    (input.value && selectedReferencesDataStatus !== REFERENCES_STATUS_READY)
      ? matchingReferencesError ||
          translate('ra.input.references.many_missing', {
              _: 'ra.input.references.many_missing',
          })
      : null,
}

// The boolean conditions in the test should look cohesive.
const selectedReferencesDataStatus =
  !isEmpty(value) && typeof value === 'string' && !pattern.test(value)
      ? getMessage(message, { pattern }, value, values)
      : undefined


// Would be nice if these two nested ternaries didn't look like a single one.
resolveRedirectTo(
  redirectTo,
  basePath,
  payload
    ? payload.id || (payload.data ? payload.data.id : null)
    : requestPayload
      ? requestPayload.id
      : null,
  payload && payload.data
    ? payload.data
    : requestPayload && requestPayload.data
      ? requestPayload.data
      : null
)
