import Settings from '../../../components/Settings';

export default function Page({ params }) {
  return <Settings slug={params.slug} />;
}
