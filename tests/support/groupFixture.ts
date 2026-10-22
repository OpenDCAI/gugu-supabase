/** Seed an already-existing group's roster. This is fixture setup, never a product join path.
 * Creation itself still runs authenticated; unrelated initial memberships are seeded
 * with the database connection's privileged role. Tested actions keep their real JWTs.
 */
export async function createFixtureGroup(
  db: { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> },
  args: [string, string, string, string],
): Promise<void> {
  const [id, name, owner, encodedMembers] = args
  const members = JSON.parse(encodedMembers) as Array<{ user_id: string; role: string }>
  const prior = (await db.query('SELECT current_user AS role')).rows[0]?.role
  await db.query('SELECT chat.create_gugu_group($1,$2,$3,\'[]\'::jsonb)', [id, name, owner])
  await db.query('RESET role')
  for (const member of members) {
    if (member.user_id === owner) continue
    await db.query('INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,$3)', [id, member.user_id, member.role])
  }
  if (prior === 'authenticated') await db.query('SET LOCAL role TO authenticated')
}
