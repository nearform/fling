/**
 * `/groups/:slug`, a group's link: the Groups list with the group open in the editor.
 */
import { Navigate, useParams } from 'react-router-dom'

export default function Group() {
  const { slug = '' } = useParams()
  return <Navigate to={`/groups?edit=${encodeURIComponent(slug)}`} replace />
}
