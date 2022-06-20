// real-world inspiration:
const ClientInstantiation = (opts) => {
  return dedent`
    const ${Names.ClientName()} = ${JS.ClassInstantiation({
      name: Names.PackageName(),
      params: [opts].filter(Boolean),
    })};
  `;
};
