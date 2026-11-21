import re, json, glob, os, sys
root = sys.argv[1]
def fm(path):
    t = open(path, encoding='utf-8').read()
    m = re.match(r'^---\s*\n(.*?)\n---', t, re.S)
    d = {}
    if m:
        block = m.group(1)
        n = re.search(r'^name:\s*(.+)$', block, re.M)
        # description may be folded/multiline
        dm = re.search(r'^description:\s*(.*?)(?=^\w[\w-]*:|\Z)', block, re.S | re.M)
        d['name'] = n.group(1).strip().strip('"\'') if n else os.path.basename(path)
        desc = dm.group(1) if dm else ''
        desc = re.sub(r'^[>|][-+]?\s*', '', desc.strip())
        desc = re.sub(r'\s+', ' ', desc).strip().strip('"\'')
        d['description'] = desc
    return d
agents = [fm(p) for p in sorted(glob.glob(f'{root}/agents/*.md'))]
skills = [fm(p) for p in sorted(glob.glob(f'{root}/skills/*/SKILL.md'))]
json.dump({'agents': agents, 'skills': skills}, open('/home/claude/work/data.json','w'), indent=1)
print(len(agents), len(skills))
for a in agents[:3]: print(a)
for s in skills[:3]: print(s)
print(max(len(x['description']) for x in agents+skills))
