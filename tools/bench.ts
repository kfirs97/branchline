/** Times the graph's data path on a repository: node dist-test/bench.js <repo> [pages] */
import { Git, parseRefs } from '../src/git';
import { GraphLayout } from '../src/graph';

const [repo, pagesArg = '10'] = process.argv.slice(2);
const git = new Git(repo);
const t = () => performance.now();

(async () => {
  let s = t();
  const refs = parseRefs(await git.run(['for-each-ref', '--format=%(objectname)\x1f%(*objectname)\x1f%(refname)']));
  console.log(`refs: ${refs.length} in ${(t() - s).toFixed(0)}ms`);

  const layout = new GraphLayout();
  let maxWidth = 0;
  let layoutMs = 0;
  for (let page = 0; page < Number(pagesArg); page++) {
    s = t();
    const commits = await git.log({ skip: page * 300, count: 301, allRefs: true });
    const logMs = t() - s;
    s = t();
    for (const c of commits.slice(0, 300)) maxWidth = Math.max(maxWidth, layout.add(c).width);
    layoutMs += t() - s;
    if (page === 0 || page === Number(pagesArg) - 1) console.log(`page ${page + 1}: git log ${logMs.toFixed(0)}ms (${commits.length} commits)`);
  }
  console.log(`layout total ${layoutMs.toFixed(1)}ms, max lanes ${maxWidth}`);
})();
